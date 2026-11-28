//! Port of `admin-back/test/core-contract.test.ts`.
//!
//! Core validates every forwarded body with a strict zod object; a single unknown key makes it
//! answer `400 VALIDATION_FAILED`. Each case here feeds the public (legacy) payload through the
//! real mapper and asserts that the result only contains keys core accepts and always contains the
//! keys core requires.

#![cfg(test)]

use serde_json::{json, Value};

use crate::contract::*;
use crate::error::EdgeResult;

type Mapper = fn(&Value) -> EdgeResult<Value>;

struct Case {
    name: &'static str,
    mapper: Mapper,
    payload: Value,
    allowed: &'static [&'static str],
    required: &'static [&'static str],
}

fn cases() -> Vec<Case> {
    vec![
        Case {
            name: "gateway create",
            mapper: to_core_gateway_create,
            payload: json!({"code":"Edfali","name":"Edfali","category":"bank","country":"ly","evidenceLevel":"partial","aliases":["Edfali"],"riskClass":"high_risk","unknown":"drop"}),
            allowed: &[
                "code",
                "name",
                "operator",
                "country",
                "kind",
                "aliases",
                "verificationState",
                "riskClass",
            ],
            required: &["code", "name", "operator", "kind"],
        },
        Case {
            name: "gateway update",
            mapper: to_core_gateway_update,
            payload: json!({"code":"Edfali","name":"Edfali","category":"bank","aliases":["E"],"evidenceLevel":"VERIFIED"}),
            allowed: &[
                "code",
                "name",
                "operator",
                "country",
                "kind",
                "aliases",
                "verificationState",
                "riskClass",
            ],
            required: &[],
        },
        Case {
            name: "gateway version create",
            mapper: to_core_gateway_version_create,
            payload: json!({"version":2,"basedOnVersionId":"v1","changelog":"note","snapshot":{"a":1}}),
            allowed: &["changeNote", "snapshot"],
            required: &["snapshot"],
        },
        Case {
            name: "gateway rollback",
            mapper: to_core_gateway_rollback,
            payload: json!({"targetVersionId":"v1","reason":"bad release","checklist":["GATES_VERIFIED"],"extra":1}),
            allowed: &["versionId", "reason", "checklist"],
            required: &["versionId"],
        },
        Case {
            name: "gateway environments",
            mapper: to_core_gateway_version_environments,
            payload: json!({"environments":[{"code":"api","env":"live","baseUrl":"https://api.example.com","allowedHosts":["api.example.com"],"inboundIpAllowlist":["10.0.0.0/8"],"outboundEgressIps":["1.2.3.4"],"enabled":true}]}),
            allowed: &[
                "env",
                "baseUrls",
                "allowedHosts",
                "inboundIpAllowlist",
                "outboundEgressIps",
                "enabled",
            ],
            required: &["env", "baseUrls", "allowedHosts"],
        },
        Case {
            name: "gateway auth",
            mapper: to_core_gateway_version_auth,
            payload: json!({"env":"LIVE","authMethod":"API_KEY","auth":{"header_name":"X-Key","keyRef":"edfali-key"},"settings":{"query_name":"k"}}),
            allowed: &["env", "method", "authApply", "refreshConfigJson"],
            required: &["env", "method", "authApply"],
        },
        Case {
            name: "gateway settings",
            mapper: to_core_gateway_version_settings,
            payload: json!({"settings":{"amountScale":100,"amountPrecision":2,"amountRounding":"NEAREST","amountFormat":"STRING_DECIMAL","sessionTtlSeconds":900,"otpTtlSeconds":300,"otpResendCooldownSeconds":30,"supportsCancel":true},"amountPipeline":{"maxOtpAttempts":4},"timeoutMs":9000}),
            allowed: &[
                "amountScale",
                "amountPrecision",
                "amountRounding",
                "amountFormat",
                "referenceFormat",
                "sessionTtlSeconds",
                "otpTtlSeconds",
                "otpResendCooldownSeconds",
                "maxOtpAttempts",
                "supportsStatusCheck",
                "statusCheckMinAgeSeconds",
                "supportsIdempotencyKey",
                "supportsCancel",
                "rateLimitPerSecond",
                "concurrencyCap",
                "timeoutMs",
                "maxResponseBytes",
                "gatewayTimezone",
            ],
            required: &[
                "amountScale",
                "amountPrecision",
                "amountRounding",
                "amountFormat",
                "referenceFormat",
                "sessionTtlSeconds",
                "otpTtlSeconds",
                "otpResendCooldownSeconds",
            ],
        },
        Case {
            name: "gateway crypto profiles",
            mapper: to_core_gateway_version_crypto_profiles,
            payload: json!({"cryptoProfiles":[{"code":"sign","encoding":"HEX","algorithm":"HMAC_SHA256","secretRef":"key","fields":["amount"]}]}),
            allowed: &["profiles"],
            required: &["profiles"],
        },
        Case {
            name: "gateway flows",
            mapper: to_core_gateway_version_flows,
            payload: json!({"flows":[{"code":"INITIATE","steps":[{"type":"HTTP","method":"POST","url":"https://x","sideEffect":"MOVES_MONEY"}]}]}),
            allowed: &["flows"],
            required: &["flows"],
        },
        Case {
            name: "gateway channels",
            mapper: to_core_gateway_version_channels,
            payload: json!({"confirmationChannels":[{"type":"WEBHOOK","pathToken":"token-12345"}],"pollPolicies":[{"kind":"POLL"}]}),
            allowed: &["channels"],
            required: &["channels"],
        },
        Case {
            name: "gateway status rules",
            mapper: to_core_gateway_version_status_rules,
            payload: json!({"statusRules":[{"gatewayCode":"0","selector":"status","op":"equals","value":"0","canonicalStatus":"SUCCEEDED"}]}),
            allowed: &["rules"],
            required: &["rules"],
        },
        Case {
            name: "gateway error maps",
            mapper: to_core_gateway_version_error_maps,
            payload: json!({"errorMaps":[{"code":"51","messageEn":"insufficient funds","otpRetryable":false}]}),
            allowed: &["maps"],
            required: &["maps"],
        },
        Case {
            name: "gateway dry run",
            mapper: to_core_gateway_version_dry_run,
            payload: json!({"payload":{"railCode":"edfali","amount":"12.5000","currency":"LYD"},"checklist":["PHASE_SELECTED"]}),
            allowed: &["railCode", "amount", "currency", "checklist"],
            required: &[],
        },
        Case {
            name: "gateway run suite",
            mapper: to_core_gateway_version_run_suite,
            payload: json!({"suite":"SANDBOX_15","scenarios":["PARSE"],"checklist":["SUITE_SELECTED"]}),
            allowed: &["scenarios", "checklist"],
            required: &[],
        },
        Case {
            name: "user create",
            mapper: to_core_user_create,
            payload: json!({"email":" A@B.CO ","password":"hunter2hunter2","phone":"+218900","role":"operator","authorities":{"security":["read","write"],"user":true}}),
            allowed: &["email", "role", "authoritiesMap", "checklist"],
            required: &["email", "role"],
        },
        Case {
            name: "user update",
            mapper: to_core_user_update,
            payload: json!({"role":"SUPPORT","status":"locked","authorities":["user:read"],"checklist":["SELECTION_REVIEWED"]}),
            allowed: &["role", "status", "authoritiesMap", "checklist"],
            required: &[],
        },
        Case {
            name: "join request assign",
            mapper: to_core_join_request_assign,
            payload: json!({"assigneeUserId":"u-1","dueAt":"2026-01-01"}),
            allowed: &["reviewerId"],
            required: &["reviewerId"],
        },
        Case {
            name: "join request request info",
            mapper: to_core_join_request_request_info,
            payload: json!({"requestedItems":["commercialRegistry"],"message":"please provide"}),
            allowed: &["items"],
            required: &["items"],
        },
        Case {
            name: "join request decide",
            mapper: to_core_join_request_decide,
            payload: json!({"decision":"APPROVE","reason":"all documents verified","proposedRiskTier":"low"}),
            allowed: &["decision", "reasonCode", "notes", "proposedRiskTier"],
            required: &["decision"],
        },
        Case {
            name: "kyb review",
            mapper: to_core_kyb_document_review,
            payload: json!({"decision":"ACCEPT","notes":"valid","expiresOn":"2027-01-01","checklist":["a"]}),
            allowed: &[
                "decision",
                "reasonCode",
                "notes",
                "duplicateJustification",
                "expiresOn",
                "checklist",
            ],
            required: &["decision"],
        },
        Case {
            name: "kyb replacement",
            mapper: to_core_kyb_document_replacement,
            payload: json!({"message":"expired document","reasonCode":"EXPIRED"}),
            allowed: &["message", "reasonCode"],
            required: &["message"],
        },
        Case {
            name: "kyb revalidation",
            mapper: to_core_kyb_document_revalidation,
            payload: json!({"message":"annual review","dueAt":"2027-01-01T00:00:00Z"}),
            allowed: &["message", "reasonCode", "dueAt"],
            required: &["message"],
        },
        Case {
            name: "merchant suspend",
            mapper: to_core_merchant_suspend,
            payload: json!({"reason":"something odd","emergency":true,"ratifyWithinHours":"24","baseVersion":3,"checklist":["IMPACT_REVIEWED"]}),
            allowed: &[
                "reasonCode",
                "notes",
                "emergency",
                "ratifyWithinHours",
                "baseVersion",
                "checklist",
            ],
            required: &["reasonCode", "notes"],
        },
        Case {
            name: "merchant reinstate",
            mapper: to_core_merchant_reinstate,
            payload: json!({"reason":"cleared","baseVersion":3}),
            allowed: &["reason", "baseVersion", "checklist"],
            required: &["reason"],
        },
        Case {
            name: "merchant propose edit",
            mapper: to_core_merchant_propose_edit,
            payload: json!({"reason":"fix name","patch":[{"op":"replace","path":"/tradeName","value":"X"}],"baseVersion":1}),
            allowed: &["patch", "reason", "baseVersion", "checklist"],
            required: &["patch"],
        },
        Case {
            name: "merchant descriptive",
            mapper: to_core_merchant_descriptive,
            payload: json!({"tradeName":"X","supportEmail":"a@b.co","reason":"typo","baseVersion":2}),
            allowed: &[
                "tradeName",
                "displayName",
                "logoUrl",
                "supportEmail",
                "supportPhone",
                "reason",
                "baseVersion",
            ],
            required: &[],
        },
        Case {
            name: "merchant close",
            mapper: to_core_merchant_close,
            payload: json!({"reasonCode":"BUSINESS_CLOSED","notes":"gone","baseVersion":4}),
            allowed: &["reasonCode", "notes", "baseVersion", "checklist"],
            required: &["reasonCode"],
        },
        Case {
            name: "merchant withdraw",
            mapper: to_core_merchant_withdraw,
            payload: json!({"reason":"changed mind"}),
            allowed: &["reason"],
            required: &[],
        },
        Case {
            name: "approval approve",
            mapper: to_core_approval_approve,
            payload: json!({"comment":"checked","outcome":"won","riskAcceptanceNote":"accepted","checklist":["DIFF_REVIEWED"]}),
            allowed: &["notes", "outcome", "riskAcceptanceNote", "checklist"],
            required: &[],
        },
        Case {
            name: "approval reject",
            mapper: to_core_approval_reject,
            payload: json!({"reason":"missing evidence"}),
            allowed: &["reason", "checklist"],
            required: &["reason"],
        },
        Case {
            name: "aml disposition",
            mapper: to_core_aml_match_disposition,
            payload: json!({"disposition":"confirmed_match","notes":"same person","suppressFuture":false}),
            allowed: &[
                "disposition",
                "notes",
                "suppressFuture",
                "suppressUntil",
                "checklist",
            ],
            required: &["disposition"],
        },
        Case {
            name: "aml case propose",
            mapper: to_core_aml_case_propose,
            payload: json!({"action":"AML_HOLD","reason":"suspicious"}),
            allowed: &["action", "notes", "checklist"],
            required: &["action"],
        },
        Case {
            name: "aml rule",
            mapper: to_core_aml_rule,
            payload: json!({"code":"R1","name":"Large","ruleType":"single_amount","action":"hold","baseSeverity":"high","params":{"amount":"10000"},"scope":{"env":"LIVE"}}),
            allowed: &[
                "code",
                "name",
                "ruleType",
                "action",
                "baseSeverity",
                "params",
                "scope",
                "effectiveFrom",
                "checklist",
            ],
            required: &[
                "code",
                "name",
                "ruleType",
                "action",
                "baseSeverity",
                "params",
            ],
        },
        Case {
            name: "aml reporting rule",
            mapper: to_core_aml_reporting_rule,
            payload: json!({"code":"LTR","name":"Large","mode":"CONFIRMED","threshold":"50000","currency":"lyd","windowDays":1}),
            allowed: &[
                "reportType",
                "sourceReference",
                "requiredOutputFormats",
                "primaryOutputFormat",
                "thresholdAmount",
                "currency",
                "windowSeconds",
            ],
            required: &[
                "reportType",
                "sourceReference",
                "requiredOutputFormats",
                "primaryOutputFormat",
            ],
        },
        Case {
            name: "aml report",
            mapper: to_core_aml_report,
            payload: json!({"reportingRuleId":"r1","caseId":"c1","periodStart":"2026-01-01","periodEnd":"2026-01-31","notes":"n","authority":"CBL"}),
            allowed: &[
                "reportType",
                "subjectType",
                "subjectId",
                "payload",
                "amlCaseId",
                "authority",
                "checklist",
            ],
            required: &["reportType", "subjectType", "subjectId", "payload"],
        },
        Case {
            name: "rail create",
            mapper: to_core_rail_create,
            payload: json!({"code":"Edfali","name":"Edfali","collectionMode":"OTP_PULL","currency":"lyd","minAmount":"1","maxAmount":"5000","capabilities":["otp"]}),
            allowed: &[
                "code",
                "nameAr",
                "nameEn",
                "collectionMode",
                "subModes",
                "currency",
                "minAmount",
                "maxAmount",
                "capabilities",
                "checklist",
            ],
            required: &["code", "nameAr", "nameEn", "collectionMode"],
        },
        Case {
            name: "rail update",
            mapper: to_core_rail_update,
            payload: json!({"name":"Edfali","active":false,"minAmount":"1","displayOrder":2,"logoAssetId":"0192f6a0-1111-7111-8111-111111111111","capabilities":{"otp":true}}),
            allowed: &[
                "nameAr",
                "nameEn",
                "blocked",
                "minAmount",
                "maxAmount",
                "instructionsAr",
                "instructionsEn",
                "displayOrder",
                "capabilities",
                "logoAssetId",
                "checklist",
            ],
            required: &[],
        },
        Case {
            name: "rail fields",
            mapper: to_core_rail_fields,
            payload: json!({"fields":[{"code":"Phone number","label":"Phone","type":"PHONE","required":true,"pattern":"^\\d+$","normalizer":"phone_normalize_e164"}]}),
            allowed: &["fields", "checklist"],
            required: &["fields"],
        },
        Case {
            name: "route create",
            mapper: to_core_route_create,
            payload: json!({"railId":"r1","gatewayId":"g1","environment":"live","credentialPolicy":"PLATFORM","priority":1,"limitAmount":"1000"}),
            allowed: &[
                "railId",
                "gatewayId",
                "credentialPolicy",
                "priority",
                "costModel",
                "maxAmount",
                "checklist",
            ],
            required: &["railId", "gatewayId", "credentialPolicy"],
        },
        Case {
            name: "route update",
            mapper: to_core_route_update,
            payload: json!({"priority":2,"weight":5,"mismatchPolicy":{},"maintenanceWindows":[],"limitAmount":"50","dailyCapAmount":"500"}),
            allowed: &[
                "priority",
                "weight",
                "costModel",
                "scope",
                "mismatchPolicy",
                "maintenanceWindows",
                "minAmount",
                "maxAmount",
                "dailyCapAmount",
                "checklist",
            ],
            required: &[],
        },
        Case {
            name: "route state",
            mapper: to_core_route_state,
            payload: json!({"state":"paused","reason":"maintenance"}),
            allowed: &["status", "reason", "checklist"],
            required: &["status"],
        },
        Case {
            name: "asset create",
            mapper: to_core_asset_create,
            payload: json!({"name":"logo","contentType":"image/png","sizeBytes":100,"storageKey":"logo.png","checksumSha256":"a".repeat(64)}),
            allowed: &["name", "mime", "sizeBytes", "storageKey", "sha256"],
            required: &["name", "mime", "sizeBytes", "storageKey", "sha256"],
        },
        Case {
            name: "operator case resolve",
            mapper: to_core_operator_case_resolve,
            payload: json!({"action":"MARK_SUCCEEDED","reason":"gateway confirmed","providerReference":"ref","settledAmount":"10.0000","resolutionCode":"FIXED_AT_SOURCE","reference":"r"}),
            allowed: &[
                "action",
                "reason",
                "notes",
                "providerReference",
                "settledAmount",
                "resolutionCode",
                "reference",
                "checklist",
            ],
            required: &["action", "reason"],
        },
        Case {
            name: "reconciliation source create",
            mapper: to_core_reconciliation_source_create,
            payload: json!({"gatewayId":"g1","type":"UPLOAD","fileType":"CSV","delimiter":",","hasHeader":true,"currency":"lyd"}),
            allowed: &[
                "gatewayId",
                "type",
                "parserConfig",
                "scheduleCron",
                "settlementLagDays",
                "dedupeKeyTemplate",
                "currency",
                "env",
                "credentialSetId",
            ],
            required: &["gatewayId", "type", "parserConfig"],
        },
        Case {
            name: "reconciliation upload",
            mapper: to_core_reconciliation_upload,
            payload: json!({"sourceId":"s1","periodStart":"2026-01-01","periodEnd":"2026-01-31","currency":"lyd","autoPost":true}),
            allowed: &[
                "sourceId",
                "periodStart",
                "periodEnd",
                "currency",
                "autoPost",
                "checklist",
            ],
            required: &["sourceId"],
        },
        Case {
            name: "dispute create",
            mapper: to_core_dispute_create,
            payload: json!({"paymentReference":"a1","gatewayId":"g1","railId":"r1","externalDisputeRef":"d1","source":"WEBHOOK","amount":"10.0000","currency":"lyd","reason":"fraud"}),
            allowed: &[
                "attemptId",
                "gatewayId",
                "railId",
                "externalDisputeRef",
                "source",
                "amount",
                "currency",
                "reasonCode",
            ],
            required: &[
                "attemptId",
                "gatewayId",
                "railId",
                "externalDisputeRef",
                "source",
                "amount",
                "currency",
            ],
        },
        Case {
            name: "adjustment create",
            mapper: to_core_adjustment_create,
            payload: json!({"type":"FEE_VARIANCE","targetGlAccountId":"gl1","amount":"1.5000","reasonCode":"fee","attemptId":"a1","reverseCommission":true}),
            allowed: &[
                "type",
                "targetGlAccountId",
                "amount",
                "reason",
                "disputeId",
                "sourceAttemptId",
                "externalDisputeRef",
                "reverseCommission",
                "checklist",
            ],
            required: &["type", "targetGlAccountId", "amount", "reason"],
        },
        Case {
            name: "cashout process",
            mapper: to_core_cashout_process,
            payload: json!({"decision":"approve","reason":"bank verified"}),
            allowed: &["decision", "reason", "checklist"],
            required: &["decision"],
        },
        Case {
            name: "commission profile create",
            mapper: to_core_commission_profile_create,
            payload: json!({"model":"mixed","railCode":"edfali","flatAmount":"1","percentage":"2.5","tiers":[{"from":0}]}),
            allowed: &[
                "railCode",
                "calcType",
                "flatFee",
                "percentageRate",
                "tiersJson",
                "minFee",
                "maxFee",
                "feeBearerDefault",
                "roundingMode",
                "merchantId",
                "applicationId",
                "checklist",
            ],
            required: &["railCode", "calcType"],
        },
        Case {
            name: "velocity rule create",
            mapper: to_core_velocity_rule_create,
            payload: json!({"scope":"IP","windowSeconds":60,"maxAttempts":5,"action":"BLOCK","maxAmount":"100"}),
            allowed: &[
                "scopeType",
                "windowSeconds",
                "maxCount",
                "action",
                "maxAmount",
                "checklist",
            ],
            required: &["scopeType", "windowSeconds", "maxCount", "action"],
        },
        Case {
            name: "settings update",
            mapper: to_core_settings_update,
            payload: json!({"settings":{"screening.fail_closed":true,"merchant_reports.policy":{"enabled":true}},"reason":"hardening","checklist":["KEY_SCOPE_VERIFIED"]}),
            allowed: &["settings", "checklist", "reason"],
            required: &["settings"],
        },
    ]
}

#[test]
fn every_mapper_only_emits_core_keys_and_required_fields() {
    for case in cases() {
        let mapped = (case.mapper)(&case.payload)
            .unwrap_or_else(|error| panic!("{} failed: {error:?}", case.name));
        let object = mapped
            .as_object()
            .unwrap_or_else(|| panic!("{} did not return an object", case.name));
        for key in object.keys() {
            assert!(
                case.allowed.contains(&key.as_str()),
                "{} emitted unknown core key {key}",
                case.name
            );
        }
        for key in case.required {
            assert!(
                object.contains_key(*key),
                "{} is missing required core key {key}",
                case.name
            );
        }
        // The whole result must be JSON-serialisable (it is forwarded as JSON).
        serde_json::to_vec(&mapped).expect("serialisable");
    }
}

#[test]
fn unsupported_public_decisions_keep_the_ts_error() {
    let error =
        to_core_join_request_decide(&json!({"decision":"REQUEST_INFO"})).expect_err("error");
    assert_eq!(error.status, 400);
    assert_eq!(error.code, "UNSUPPORTED_DECISION");
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|value| value.get("decision")),
        Some(&json!("REQUEST_INFO"))
    );

    let error =
        to_core_kyb_document_review(&json!({"decision":"REQUEST_INFO"})).expect_err("error");
    assert_eq!(error.code, "UNSUPPORTED_DECISION");

    let error = to_core_cashout_process(&json!({"decision":"HOLD"})).expect_err("error");
    assert_eq!(error.code, "UNSUPPORTED_DECISION");
}

#[test]
fn missing_canonical_fields_raise_validation_failed_with_the_path() {
    let error = to_core_route_create(&json!({"railId":"r1","gatewayId":"g1"})).expect_err("error");
    assert_eq!(error.status, 400);
    assert_eq!(error.code, "VALIDATION_FAILED");
    assert_eq!(
        error.details.as_ref().and_then(|value| value.get("path")),
        Some(&json!(["credentialPolicy"]))
    );
    let error =
        to_core_rail_create(&json!({"code":"x","collectionMode":"WAT"})).expect_err("error");
    assert_eq!(
        error.details.as_ref().and_then(|value| value.get("path")),
        Some(&json!(["collectionMode"]))
    );
}

#[test]
fn user_create_never_forwards_credentials() {
    let mapped = to_core_user_create(&json!({
        "email":"A@B.CO","role":"OPERATOR","password":"Hunter2Hunter2","phone":"+218900",
        "authorities":{"security":["read"]}
    }))
    .expect("map");
    assert_eq!(mapped["email"], "a@b.co");
    assert!(mapped.get("password").is_none());
    assert!(mapped.get("phone").is_none());
}

#[test]
fn tiered_commissions_are_an_ordered_array() {
    let mapped = to_core_commission_profile_create(&json!({
        "model":"TIERED","railCode":"edfali",
        "tiers":[{"from":"0","to":"100","percentage":"1"},{"from":"100","to":null,"percentage":"0.5"}]
    }))
    .expect("map");
    assert_eq!(mapped["calcType"], "TIERED");
    assert_eq!(mapped["tiersJson"].as_array().map(Vec::len), Some(2));
}

#[test]
fn environments_deduplicate_hosts_and_clamp() {
    let mapped = to_core_gateway_version_environments(&json!({
        "environments":[
            {"code":"api","env":"live","baseUrl":"https://api.example.com/v1","allowedHosts":["api.example.com","api.example.com"]},
            {"code":"sandbox","env":"sandbox","baseUrl":"https://sandbox.example.com"}
        ],
        "env":"live"
    }))
    .expect("map");
    assert_eq!(mapped["env"], "LIVE");
    assert_eq!(mapped["baseUrls"]["api"], "https://api.example.com/v1");
    assert_eq!(mapped["allowedHosts"], json!(["api.example.com"]));
}

#[test]
fn backup_policy_enforces_cron_gaps() {
    use crate::schema::parse_or_throw;
    let valid = json!({
        "fullCron":"0 2 * * *","deltaCron":"*/15 * * * *","drillCron":"0 4 * * 0",
        "fullRetentionDays":30,"walRetentionDays":7,"alertLagSeconds":300
    });
    assert!(parse_or_throw(&crate::schemas::backup_policy(), &valid).is_ok());

    let storm = json!({
        "fullCron":"0 2 * * *","deltaCron":"* * * * *","drillCron":"0 4 * * 0",
        "fullRetentionDays":30,"walRetentionDays":7,"alertLagSeconds":300
    });
    let error = parse_or_throw(&crate::schemas::backup_policy(), &storm).expect_err("storm");
    assert_eq!(error.code, "VALIDATION_FAILED");
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|d| d.get(0))
            .and_then(|i| i.get("code")),
        Some(&json!("custom"))
    );

    let invalid = json!({
        "fullCron":"@daily","deltaCron":"*/15 * * * *","drillCron":"0 4 * * 0",
        "fullRetentionDays":30,"walRetentionDays":7,"alertLagSeconds":300
    });
    assert!(parse_or_throw(&crate::schemas::backup_policy(), &invalid).is_err());
}
