//! DB-gated tests for the AML admin GETs (schema 46, local PostgreSQL).
//!
//! Every test skips cleanly when `postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test`
//! is unreachable or is not at schema 46. Fixtures use random UUIDs and a unique suffix; cleanup
//! removes every row the test created (including audit rows through the documented
//! `pgw.audit_retention` maintenance GUC).

use std::sync::Arc;
use std::time::Duration;

use chrono::{NaiveDate, Utc};
use ntex::web::test;
use ntex::web::HttpRequest;
use pg_crypto::sha256_hex;
use pg_crypto::vault::{EnvironmentKeyResolver, Vault};
use pg_domain_auth::{Channel as AuthChannel, Principal, PrincipalKind};
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use uuid::Uuid;

use super::*;
use crate::config::CoreConfig;
use crate::state::AppState;

const TEST_DB: &str = "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test";
const MASTER: &str = "phase-test-master-key-value";
const SCHEMA_VERSION: i32 = 46;

async fn test_state() -> Option<Arc<AppState>> {
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(Duration::from_secs(2))
        .connect(TEST_DB)
        .await
        .ok()?;
    let version: Option<i32> =
        sqlx::query_scalar("SELECT version FROM schema_versions ORDER BY version DESC LIMIT 1")
            .fetch_optional(&pool)
            .await
            .ok()
            .flatten();
    pool.close().await;
    if version != Some(SCHEMA_VERSION) {
        return None;
    }
    // The vault helpers read the process environment exactly like the TS `Vault`.
    std::env::set_var("KMS_MASTER_KEY", MASTER);
    AppState::connect(CoreConfig::for_tests(TEST_DB, MASTER))
        .await
        .ok()
}

fn principal(user_id: Uuid, role: &str, authorities: &[&str]) -> Principal {
    Principal {
        kind: PrincipalKind::Session,
        user_id: Some(user_id.to_string()),
        role: Some(role.to_owned()),
        merchant_id: None,
        application_id: None,
        authorities: authorities
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
        scopes: authorities
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
        token_id: None,
        token_plane: None,
        session_jti: None,
        session_exp: None,
        session_channel: Some(AuthChannel::Admin),
        app_scope_ids: Vec::new(),
    }
}

fn request(uri: &str) -> HttpRequest {
    test::TestRequest::default().uri(uri).to_http_request()
}

async fn body(response: ntex::web::HttpResponse) -> Value {
    let bytes = test::read_body(response).await;
    serde_json::from_slice(&bytes).expect("a JSON response body")
}

fn error(result: Result<ntex::web::HttpResponse, ApiError>) -> ApiError {
    match result {
        Ok(_) => panic!("expected an error response"),
        Err(error) => error,
    }
}

fn vault_encrypt(plaintext: &str, key_id: &str) -> String {
    let mut env = std::collections::BTreeMap::new();
    env.insert("KMS_MASTER_KEY".to_owned(), MASTER.to_owned());
    let vault = Vault::new(EnvironmentKeyResolver::from_map(env));
    vault
        .encrypt_secret(plaintext, key_id)
        .expect("vault encrypt")
}

struct Fixture {
    suffix: String,
    user: Uuid,
    merchant: Uuid,
    owner: Uuid,
    screening_open: Uuid,
    screening_clear: Uuid,
    rule: Uuid,
    case_open: Uuid,
    case_review: Uuid,
    schema_xml: Uuid,
    schema_xlsx: Uuid,
    schema_template: Uuid,
    reporting_rule: Uuid,
    report_rule: Uuid,
    report_incident: Uuid,
    output_xml: Uuid,
    adapter: Uuid,
    incident: Uuid,
    evidence: Uuid,
    object: Uuid,
}

fn hex64(value: &str) -> String {
    sha256_hex(value.as_bytes())
}

async fn create_fixture(pool: &PgPool) -> Fixture {
    let suffix = Uuid::new_v4().simple().to_string();
    let user = Uuid::new_v4();
    let merchant = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let screening_open = Uuid::new_v4();
    let screening_clear = Uuid::new_v4();
    let rule = Uuid::new_v4();
    let case_open = Uuid::new_v4();
    let case_review = Uuid::new_v4();
    let schema_xml = Uuid::new_v4();
    let schema_xlsx = Uuid::new_v4();
    let schema_template = Uuid::new_v4();
    let reporting_rule = Uuid::new_v4();
    let report_rule = Uuid::new_v4();
    let report_incident = Uuid::new_v4();
    let output_xml = Uuid::new_v4();
    let adapter = Uuid::new_v4();
    let incident = Uuid::new_v4();
    let evidence = Uuid::new_v4();
    let object = Uuid::new_v4();
    let now = Utc::now().naive_utc();
    let report_code = format!("T{}", &suffix[..12]);
    let period_key = format!("P{}", &suffix[..12]);

    sqlx::query(
        "INSERT INTO users (id, created_at, updated_at, email, role, authorities_map, is_maker, is_checker, mfa_required, status) \
         VALUES ($1, now(), now(), $2, 'COMPLIANCE'::\"UserRole\", '{\"aml:read\":true}'::jsonb, true, true, false, 'ACTIVE'::\"UserStatus\")",
    )
    .bind(user)
    .bind(format!("aml-p4-{suffix}@gateway.test"))
    .execute(pool)
    .await
    .expect("test user");

    sqlx::query(
        "INSERT INTO merchants (id, created_at, updated_at, legal_name, trade_name, status, kyb_status, onboarding_channel, country, negative_balance_ceiling) \
         VALUES ($1, now(), now(), $2, $3, 'ACTIVE'::\"MerchantStatus\", 'VERIFIED'::\"KybStatus\", 'TEST', 'LY', 0)",
    )
    .bind(merchant)
    .bind(format!("AML Test Legal {suffix}"))
    .bind(format!("AML Test Trade {suffix}"))
    .execute(pool)
    .await
    .expect("test merchant");

    sqlx::query(
        "INSERT INTO beneficial_owners (id, created_at, updated_at, merchant_id, full_name_ar, full_name_en, national_id_ciphertext, date_of_birth, nationality, role, valid_from) \
         VALUES ($1, now(), now(), $2, 'مالك', $3, 'cipher', '1990-01-01', 'LY', 'OWNER'::\"BeneficialOwnerRole\", now())",
    )
    .bind(owner)
    .bind(merchant)
    .bind(format!("AML Owner {suffix}"))
    .execute(pool)
    .await
    .expect("test owner");

    for (id, subject_type, subject_id, result, score, requested_at) in [
        (
            screening_open,
            "MERCHANT",
            merchant.to_string(),
            "POTENTIAL_MATCH",
            Some(rust_decimal::Decimal::new(9_550, 2)),
            now - chrono::Duration::hours(2),
        ),
        (
            screening_clear,
            "BENEFICIAL_OWNER",
            owner.to_string(),
            "CLEAR",
            None,
            now - chrono::Duration::days(2),
        ),
    ] {
        sqlx::query(
            "INSERT INTO aml_screenings (id, created_at, updated_at, subject_type, subject_id, trigger, provider_code, provider_request_ref, list_versions_json, input_hash, result, match_count, highest_score, requested_at, completed_at) \
             VALUES ($1, $7, $7, $2::\"AmlScreeningSubjectType\", $3, 'ONBOARDING'::\"AmlScreeningTrigger\", $4, $5, '{\"SANCTIONS\":\"v1\"}'::jsonb, $6, $8::\"AmlScreeningResult\", $9, $10, $7, $7)",
        )
        .bind(id)
        .bind(subject_type)
        .bind(subject_id)
        .bind(format!("TESTPROV-{suffix}"))
        .bind(format!("REQ-{suffix}"))
        .bind(hex64(&format!("screening-{id}")))
        .bind(requested_at)
        .bind(result)
        .bind(if result == "POTENTIAL_MATCH" { 2_i32 } else { 0_i32 })
        .bind(score)
        .execute(pool)
        .await
        .expect("test screening");
    }

    sqlx::query(
        "INSERT INTO aml_screening_matches (id, created_at, updated_at, screening_id, list_type, list_name, list_entry_ref, matched_name, score, attributes_json, disposition) \
         VALUES ($1, now(), now(), $2, 'SANCTIONS'::\"AmlMatchListType\", 'Sanctions list', 'ENT-1', 'Matched Name', 95.00, '{}'::jsonb, 'UNREVIEWED'::\"AmlMatchDisposition\")",
    )
    .bind(Uuid::new_v4())
    .bind(screening_open)
    .execute(pool)
    .await
    .expect("test sanctions match");
    sqlx::query(
        "INSERT INTO aml_screening_matches (id, created_at, updated_at, screening_id, list_type, list_name, list_entry_ref, matched_name, score, attributes_json, disposition) \
         VALUES ($1, now(), now(), $2, 'PEP'::\"AmlMatchListType\", 'PEP list', 'ENT-2', 'Another Name', 40.00, '{}'::jsonb, 'FALSE_POSITIVE'::\"AmlMatchDisposition\")",
    )
    .bind(Uuid::new_v4())
    .bind(screening_open)
    .execute(pool)
    .await
    .expect("test pep match");

    sqlx::query(
        "INSERT INTO aml_rules (id, created_at, updated_at, code, name, rule_type, scope, params, action, base_severity, active, version, effective_from) \
         VALUES ($1, now(), now(), $2, $3, 'SINGLE_AMOUNT'::\"AmlRuleType\", '{}'::jsonb, '{\"threshold\":\"1000\"}'::jsonb, 'HOLD'::\"AmlRuleAction\", 'HIGH'::\"AmlBaseSeverity\", true, 1, now() - interval '1 day')",
    )
    .bind(rule)
    .bind(format!("TEST_RULE_{suffix}"))
    .bind(format!("Test rule {suffix}"))
    .execute(pool)
    .await
    .expect("test rule");

    sqlx::query(
        "INSERT INTO aml_cases (id, created_at, updated_at, subject_type, subject_id, trigger_reason, severity, severity_inputs_json, screening_id, rule_id, rule_version, status, sla_due_at, assigned_reviewer_id, confidential, reviewer_notes) \
         VALUES ($1, $5, $5, 'MERCHANT'::\"AmlSubjectType\", $2, $3, 'HIGH'::\"AmlSeverity\", '{\"amount\":\"100\"}'::jsonb, $4, $6, 1, 'OPEN'::\"AmlCaseStatus\", now() - interval '1 hour', $7, true, 'review me')",
    )
    .bind(case_open)
    .bind(merchant.to_string())
    .bind(format!("TESTCASE {suffix}"))
    .bind(screening_open)
    .bind(now - chrono::Duration::hours(3))
    .bind(rule)
    .bind(user)
    .execute(pool)
    .await
    .expect("test open case");
    sqlx::query(
        "INSERT INTO aml_cases (id, created_at, updated_at, subject_type, subject_id, trigger_reason, severity, severity_inputs_json, status, sla_due_at, confidential) \
         VALUES ($1, $3, $3, 'BENEFICIAL_OWNER'::\"AmlSubjectType\", $2, $4, 'LOW'::\"AmlSeverity\", '{}'::jsonb, 'IN_REVIEW'::\"AmlCaseStatus\", now() + interval '2 days', true)",
    )
    .bind(case_review)
    .bind(owner.to_string())
    .bind(now - chrono::Duration::days(2))
    .bind(format!("TESTCASE review {suffix}"))
    .execute(pool)
    .await
    .expect("test review case");

    sqlx::query(
        "INSERT INTO incidents (id, created_at, updated_at, reference, title, detected_at) VALUES ($1, now(), now(), $2, $3, now())",
    )
    .bind(incident)
    .bind(format!("INC-TEST-{suffix}"))
    .bind(format!("Test incident {suffix}"))
    .execute(pool)
    .await
    .expect("test incident");

    let xml_compiled = json!({
        "rootElement": {"name": "Report"},
        "paths": {"Report": {}, "Report/Amount": {}},
        "codeLists": {"Currency": {}},
    });
    let xlsx_compiled = json!({
        "paths": {},
        "codeLists": {},
        "narrativeSections": [{"key": "summary", "title": "Summary", "required": true}],
    });
    for (id, format, status, name, compiled) in [
        (
            schema_xml,
            "XML",
            "CONFIRMED",
            "Test XML schema",
            xml_compiled,
        ),
        (
            schema_xlsx,
            "XLSX",
            "DRAFT",
            "Test XLSX schema",
            xlsx_compiled,
        ),
        (
            schema_template,
            "XLSX",
            "DRAFT",
            "Test template schema",
            json!({"paths": {}, "codeLists": {}}),
        ),
    ] {
        sqlx::query(
            "INSERT INTO regulatory_report_schemas (id, created_at, updated_at, authority, report_type, report_code, format, schema_code, name, version, revision, status, definition_text, definition_sha256, mapping_sha256, compiled_definition_json, mapping_blueprint_json, sample_context_json, notes) \
             VALUES ($1, now(), now(), 'CBL', 'LARGE_TRANSACTION'::\"ReportingType\", $2, $3::\"ReportOutputFormat\", $4, $5, 1, 1, $6::\"RegulatorySchemaStatus\", '<xsd/>', $7, $8, $9, '{}'::jsonb, '{\"merchant\":{\"id\":\"m\"}}'::jsonb, 'notes')",
        )
        .bind(id)
        .bind(report_code.clone())
        .bind(format)
        .bind(format!("TEST_{format}_{id}"))
        .bind(format!("{name} {suffix}"))
        .bind(status)
        .bind(hex64(&format!("definition-{id}")))
        .bind(hex64(&format!("mapping-{id}")))
        .bind(compiled)
        .execute(pool)
        .await
        .expect("test schema");
    }
    let template_bytes = b"PK\x03\x04test-template";
    sqlx::query(
        "UPDATE regulatory_report_schemas SET template_ciphertext = $1, template_sha256 = $2, template_binding_json = '{\"sheet\":\"LTR\"}'::jsonb WHERE id = $3",
    )
    .bind(vault_encrypt(&base64_encode(template_bytes), "reporting-xlsx"))
    .bind(sha256_hex(template_bytes))
    .bind(schema_template)
    .execute(pool)
    .await
    .expect("test template");

    sqlx::query(
        "INSERT INTO regulatory_schema_default_bindings (id, created_at, updated_at, authority, report_type, report_code, format, schema_id) \
         VALUES ($1, now(), now(), 'CBL', 'LARGE_TRANSACTION'::\"ReportingType\", $2, 'XML'::\"ReportOutputFormat\", $3)",
    )
    .bind(Uuid::new_v4())
    .bind(report_code.clone())
    .bind(schema_xml)
    .execute(pool)
    .await
    .expect("test default binding");

    sqlx::query(
        "INSERT INTO reporting_rules (id, created_at, updated_at, authority, report_type, threshold_amount, currency, conditions, source_reference, status, effective_from, required_output_formats) \
         VALUES ($1, now(), now(), 'CBL', 'LARGE_TRANSACTION'::\"ReportingType\", 10000.0000, 'LYD', '{}'::jsonb, $2, 'PROVISIONAL'::\"ReportingRuleStatus\", now() - interval '1 day', ARRAY['XML']::\"ReportOutputFormat\"[])",
    )
    .bind(reporting_rule)
    .bind(format!("Test reporting rule {suffix}"))
    .execute(pool)
    .await
    .expect("test reporting rule");
    sqlx::query(
        "INSERT INTO regulatory_rule_schema_bindings (id, rule_id, format, schema_id) VALUES ($1, $2, 'XML'::\"ReportOutputFormat\", $3)",
    )
    .bind(Uuid::new_v4())
    .bind(reporting_rule)
    .bind(schema_xml)
    .execute(pool)
    .await
    .expect("test rule binding");

    let payload = json!({"narrative": {"riskAssessment": "ok"}, "pending": ["summary"]});
    let payload_text = payload.to_string();
    let payload_sha = hex64(&payload_text);
    sqlx::query(
        "INSERT INTO regulatory_reports (id, created_at, updated_at, report_type, authority, subject_type, subject_id, aml_case_id, period_start, period_end, status, payload_ciphertext, payload_sha256, submission_ref, report_code, period_key, required_output_formats, due_at) \
         VALUES ($1, $7, $7, 'LARGE_TRANSACTION'::\"ReportingType\", 'CBL', 'REPORTING_RULE', $2, $3, now() - interval '1 day', now(), 'DRAFT'::\"RegulatoryReportStatus\", $4, $5, $6, $8, $9, ARRAY['XML']::\"ReportOutputFormat\"[], now() + interval '1 day')",
    )
    .bind(report_rule)
    .bind(reporting_rule.to_string())
    .bind(case_open)
    .bind(&payload_text)
    .bind(&payload_sha)
    .bind(format!("TEST-SUB-{suffix}"))
    .bind(now - chrono::Duration::hours(1))
    .bind(report_code.clone())
    .bind(period_key.clone())
    .execute(pool)
    .await
    .expect("test report");
    sqlx::query(
        "INSERT INTO regulatory_reports (id, created_at, updated_at, report_type, authority, subject_type, subject_id, status, payload_ciphertext, payload_sha256, submission_ref, required_output_formats) \
         VALUES ($1, $3, $3, 'INCIDENT'::\"ReportingType\", 'CBL', 'INCIDENT', $2, 'SUBMITTED'::\"RegulatoryReportStatus\", '{}', $4, $5, ARRAY[]::\"ReportOutputFormat\"[])",
    )
    .bind(report_incident)
    .bind(incident.to_string())
    .bind(now - chrono::Duration::days(1))
    .bind(hex64("incident-payload"))
    .bind(format!("TEST-SUB2-{suffix}"))
    .execute(pool)
    .await
    .expect("test incident report");

    let xml_bytes = b"<Report/>";
    sqlx::query(
        "INSERT INTO regulatory_report_outputs (id, created_at, updated_at, report_id, format, revision, schema_id, schema_version, content_ciphertext, content_sha256, payload_sha256, validation_status, generated_at) \
         VALUES ($1, now(), now(), $2, 'XML'::\"ReportOutputFormat\", 1, $3, 1, $4, $5, $6, 'VALIDATED'::\"ReportOutputValidationStatus\", now())",
    )
    .bind(output_xml)
    .bind(report_rule)
    .bind(schema_xml)
    .bind(vault_encrypt("<Report/>", "reporting-xml"))
    .bind(sha256_hex(xml_bytes))
    .bind(&payload_sha)
    .execute(pool)
    .await
    .expect("test output");

    sqlx::query(
        "INSERT INTO external_filing_adapters (id, created_at, updated_at, name, authority, kind, status, timeout_seconds, config_json) \
         VALUES ($1, now(), now(), $2, 'CBL', 'MANUAL'::\"FilingAdapterKind\", 'ACTIVE'::\"FilingAdapterStatus\", 30, '{\"endpoint\":\"x\",\"apiKey\":\"secret\"}'::jsonb)",
    )
    .bind(adapter)
    .bind(format!("Test adapter {suffix}"))
    .execute(pool)
    .await
    .expect("test adapter");
    sqlx::query(
        "INSERT INTO external_submissions (id, created_at, updated_at, report_id, adapter_id, status, request_sha256, external_ref, response_code) \
         VALUES ($1, now(), now(), $2, $3, 'SUBMITTED'::\"ExternalSubmissionStatus\", $4, $5, 200)",
    )
    .bind(Uuid::new_v4())
    .bind(report_rule)
    .bind(adapter)
    .bind(hex64("submission"))
    .bind(format!("EXT-{suffix}"))
    .execute(pool)
    .await
    .expect("test submission");

    sqlx::query(
        "INSERT INTO storage_objects (id, bucket, namespace, storage_key, status, sha256_hex, byte_size, chunk_size_bytes, chunk_count, detected_mime_type, original_filename, kek_key_version, wrapped_dek, dek_nonce, stream_nonce_prefix, uploaded_by_actor_type, uploaded_by_actor_id, required_authority, staging_expires_at, av_scan_status) \
         VALUES ($1, 'HOT'::\"StorageBucketTier\", 'AML_CASE_ATTACHMENTS'::\"StorageNamespace\", $2, 'QUARANTINE_REJECTED'::\"StorageObjectStatus\", $3, 4, 65536, 1, 'application/pdf', 'evidence.pdf', 1, $4, $5, $6, 'ADMIN', $7, 'compliance:aml:read', now(), 'CLEAN'::\"StorageAvScanStatus\")",
    )
    .bind(object)
    .bind(format!("aml_case_attachments/shared/2026/11/{object}.v1.enc"))
    .bind(hex64("object"))
    .bind(vec![0_u8; 32])
    .bind(vec![0_u8; 12])
    .bind(vec![0_u8; 8])
    .bind(user.to_string())
    .execute(pool)
    .await
    .expect("test storage object");
    sqlx::query(
        "INSERT INTO aml_case_evidence (id, aml_case_id, storage_object_id, evidence_type, notes, uploaded_by_id) \
         VALUES ($1, $2, $3, 'DOCUMENT', 'note', $4)",
    )
    .bind(evidence)
    .bind(case_open)
    .bind(object)
    .bind(user.to_string())
    .execute(pool)
    .await
    .expect("test evidence");

    Fixture {
        suffix,
        user,
        merchant,
        owner,
        screening_open,
        screening_clear,
        rule,
        case_open,
        case_review,
        schema_xml,
        schema_xlsx,
        schema_template,
        reporting_rule,
        report_rule,
        report_incident,
        output_xml,
        adapter,
        incident,
        evidence,
        object,
    }
}

async fn cleanup(pool: &PgPool, fixture: &Fixture) {
    let mut connection = pool.acquire().await.expect("cleanup connection");
    let _ = sqlx::query("SET pgw.audit_retention = 'on'")
        .execute(&mut *connection)
        .await;
    let _ = sqlx::query("DELETE FROM audit_log WHERE actor_id = $1")
        .bind(fixture.user)
        .execute(&mut *connection)
        .await;
    let reports = vec![fixture.report_rule, fixture.report_incident];
    let schemas = vec![
        fixture.schema_xml,
        fixture.schema_xlsx,
        fixture.schema_template,
    ];
    let cases = vec![fixture.case_open, fixture.case_review];
    let screenings = vec![fixture.screening_open, fixture.screening_clear];
    let _ = sqlx::query("DELETE FROM external_submissions WHERE report_id = ANY($1)")
        .bind(&reports)
        .execute(&mut *connection)
        .await;
    let _ = sqlx::query("DELETE FROM regulatory_report_outputs WHERE report_id = ANY($1)")
        .bind(&reports)
        .execute(&mut *connection)
        .await;
    let _ = sqlx::query("DELETE FROM regulatory_reports WHERE id = ANY($1)")
        .bind(&reports)
        .execute(&mut *connection)
        .await;
    let _ = sqlx::query("DELETE FROM regulatory_schema_default_bindings WHERE schema_id = ANY($1)")
        .bind(&schemas)
        .execute(&mut *connection)
        .await;
    let _ = sqlx::query("DELETE FROM regulatory_rule_schema_bindings WHERE schema_id = ANY($1)")
        .bind(&schemas)
        .execute(&mut *connection)
        .await;
    let _ = sqlx::query("DELETE FROM regulatory_report_schemas WHERE id = ANY($1)")
        .bind(&schemas)
        .execute(&mut *connection)
        .await;
    let _ = sqlx::query("DELETE FROM reporting_rules WHERE id = $1")
        .bind(fixture.reporting_rule)
        .execute(&mut *connection)
        .await;
    let _ = sqlx::query("DELETE FROM aml_case_evidence WHERE id = $1")
        .bind(fixture.evidence)
        .execute(&mut *connection)
        .await;
    // Storage-object rows are append-only (the guard refuses DELETE); retire the row as the
    // product does instead of deleting it: claim, then transition to PURGED.
    let _ = sqlx::query(
        "UPDATE storage_objects SET gc_claim_token = gen_random_uuid(), gc_claimed_at = now() WHERE id = $1",
    )
    .bind(fixture.object)
    .execute(&mut *connection)
    .await;
    let _ = sqlx::query(
        "UPDATE storage_objects SET status = 'PURGED'::\"StorageObjectStatus\", purged_at = now() WHERE id = $1",
    )
    .bind(fixture.object)
    .execute(&mut *connection)
    .await;
    let _ = sqlx::query("DELETE FROM aml_cases WHERE id = ANY($1)")
        .bind(&cases)
        .execute(&mut *connection)
        .await;
    let _ = sqlx::query("DELETE FROM aml_screening_matches WHERE screening_id = ANY($1)")
        .bind(&screenings)
        .execute(&mut *connection)
        .await;
    let _ = sqlx::query("DELETE FROM aml_screenings WHERE id = ANY($1)")
        .bind(&screenings)
        .execute(&mut *connection)
        .await;
    let _ = sqlx::query("DELETE FROM aml_rules WHERE id = $1")
        .bind(fixture.rule)
        .execute(&mut *connection)
        .await;
    let _ = sqlx::query("DELETE FROM incidents WHERE id = $1")
        .bind(fixture.incident)
        .execute(&mut *connection)
        .await;
    let _ = sqlx::query("DELETE FROM external_filing_adapters WHERE id = $1")
        .bind(fixture.adapter)
        .execute(&mut *connection)
        .await;
    let _ = sqlx::query("DELETE FROM beneficial_owners WHERE id = $1")
        .bind(fixture.owner)
        .execute(&mut *connection)
        .await;
    let deleted = sqlx::query("DELETE FROM merchants WHERE id = $1")
        .bind(fixture.merchant)
        .execute(&mut *connection)
        .await;
    if deleted.map(|result| result.rows_affected()).unwrap_or(0) == 0 {
        // Another suite may have written an append-only merchant-report row for this fixture
        // merchant; retiring the name keeps the shared fixture namespace clean.
        let _ = sqlx::query(
            "UPDATE merchants SET trade_name = 'ZZ retired AML test ' || id, status = 'CLOSED'::\"MerchantStatus\" WHERE id = $1",
        )
        .bind(fixture.merchant)
        .execute(&mut *connection)
        .await;
    }
    let _ = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(fixture.user)
        .execute(&mut *connection)
        .await;
}

#[tokio::test]
async fn cases_list_filters_pagination_confidentiality_and_detail() {
    let Some(state) = test_state().await else {
        return;
    };
    let fixture = create_fixture(&state.pools.main).await;
    let actor = principal(fixture.user, "COMPLIANCE", &[]);
    let now = Utc::now();
    let yesterday = now.date_naive() - chrono::Duration::days(1);
    let tomorrow = now.date_naive() + chrono::Duration::days(1);

    // Confidentiality matrix.
    let denied = error(
        cases_list_impl(
            &state,
            &request("/internal/admin/aml/cases"),
            Some(&principal(fixture.user, "FINANCE", &["compliance:read"])),
        )
        .await,
    );
    assert_eq!(denied.status, 403);
    assert_eq!(denied.code, "AML_CONFIDENTIAL_ROLE_REQUIRED");
    let finance_allowed = cases_list_impl(
        &state,
        &request("/internal/admin/aml/cases?pageSize=1"),
        Some(&principal(fixture.user, "FINANCE", &["aml:read"])),
    )
    .await
    .expect("aml:read may read cases");
    assert_eq!(finance_allowed.status(), ntex::http::StatusCode::OK);

    // Search + filters.
    let response = cases_list_impl(
        &state,
        &request(&format!(
            "/internal/admin/aml/cases?search={}&status=OPEN&severity=HIGH&subjectType=MERCHANT&ruleCode=TEST_RULE_{}",
            fixture.suffix, fixture.suffix
        )),
        Some(&actor),
    )
    .await
    .expect("list");
    let value = body(response).await;
    assert_eq!(value["total"], json!(1));
    assert_eq!(
        value["cases"][0]["id"],
        json!(fixture.case_open.to_string())
    );
    assert_eq!(
        value["cases"][0]["caseRef"],
        json!(view::case_ref(fixture.case_open))
    );
    assert_eq!(
        value["cases"][0]["subjectName"],
        json!(format!("AML Test Trade {}", fixture.suffix))
    );
    assert_eq!(
        value["cases"][0]["ruleCode"],
        json!(format!("TEST_RULE_{}", fixture.suffix))
    );
    assert_eq!(value["cases"][0]["slaOverdue"], json!(true));

    // SLA date filter.
    let response = cases_list_impl(
        &state,
        &request(&format!(
            "/internal/admin/aml/cases?search={}&status=OPEN&dateFrom={}&dateTo={}",
            fixture.suffix, yesterday, tomorrow
        )),
        Some(&actor),
    )
    .await
    .expect("date filter");
    let value = body(response).await;
    assert_eq!(value["total"], json!(1));

    // Enum sort uses declaration order (OPEN before IN_REVIEW).
    let response = cases_list_impl(
        &state,
        &request(&format!(
            "/internal/admin/aml/cases?search={}&sortKey=status&sortDirection=asc&pageSize=20",
            fixture.suffix
        )),
        Some(&actor),
    )
    .await
    .expect("status sort");
    let value = body(response).await;
    assert_eq!(
        value["cases"][0]["id"],
        json!(fixture.case_open.to_string())
    );
    assert_eq!(
        value["cases"][1]["id"],
        json!(fixture.case_review.to_string())
    );

    // Keyset cursor on createdAt (page 1 → page 2, no overlap).
    let response = cases_list_impl(
        &state,
        &request(&format!(
            "/internal/admin/aml/cases?search={}&sortKey=openedAt&sortDirection=desc&pageSize=1",
            fixture.suffix
        )),
        Some(&actor),
    )
    .await
    .expect("cursor page one");
    let value = body(response).await;
    assert_eq!(
        value["cases"][0]["id"],
        json!(fixture.case_open.to_string())
    );
    let cursor = value["nextCursor"].as_str().expect("nextCursor").to_owned();
    let response = cases_list_impl(
        &state,
        &request(&format!(
            "/internal/admin/aml/cases?search={}&sortKey=openedAt&sortDirection=desc&pageSize=1&cursor={cursor}",
            fixture.suffix
        )),
        Some(&actor),
    )
    .await
    .expect("cursor page two");
    let value = body(response).await;
    assert_eq!(
        value["cases"][0]["id"],
        json!(fixture.case_review.to_string())
    );
    assert_eq!(value["page"], json!(1));

    // includeTotal=false still counts in the AML handlers (TS never skips the COUNT).
    let response = cases_list_impl(
        &state,
        &request(&format!(
            "/internal/admin/aml/cases?search={}&includeTotal=false",
            fixture.suffix
        )),
        Some(&actor),
    )
    .await
    .expect("includeTotal");
    let value = body(response).await;
    assert_eq!(value["total"], json!(2));

    // Detail.
    let response = case_detail_impl(
        &state,
        &request(&format!("/internal/admin/aml/cases/{}", fixture.case_open)),
        Some(&actor),
    )
    .await
    .expect("detail");
    let value = body(response).await;
    assert_eq!(value["case"]["id"], json!(fixture.case_open.to_string()));
    assert_eq!(
        value["case"]["screening"]["id"],
        json!(fixture.screening_open.to_string())
    );
    assert_eq!(
        value["case"]["screening"]["matches"]
            .as_array()
            .map(Vec::len),
        Some(2)
    );
    assert_eq!(
        value["case"]["assignedReviewerName"],
        json!(format!("aml-p4-{}@gateway.test", fixture.suffix))
    );

    // Evidence list and 404s.
    let response = case_evidence_impl(
        &state,
        &request(&format!(
            "/internal/admin/aml/cases/{}/evidence",
            fixture.case_open
        )),
        Some(&actor),
    )
    .await
    .expect("evidence");
    let value = body(response).await;
    assert_eq!(
        value["evidence"][0]["id"],
        json!(fixture.evidence.to_string())
    );
    assert_eq!(value["evidence"][0]["byteSize"], json!("4"));
    assert_eq!(value["evidence"][0]["fileName"], json!("evidence.pdf"));

    let missing = error(
        case_detail_impl(
            &state,
            &request(&format!("/internal/admin/aml/cases/{}", Uuid::new_v4())),
            Some(&actor),
        )
        .await,
    );
    assert_eq!(missing.status, 404);
    assert_eq!(missing.code, "AML_CASE_NOT_FOUND");
    let missing = error(
        screening_detail_impl(
            &state,
            &request(&format!(
                "/internal/admin/aml/screenings/{}",
                Uuid::new_v4()
            )),
            Some(&actor),
        )
        .await,
    );
    assert_eq!(missing.status, 404);
    let missing = error(
        case_evidence_content_impl(
            &state,
            &request(&format!(
                "/internal/admin/aml/cases/{}/evidence/{}/content",
                fixture.case_open,
                Uuid::new_v4()
            )),
            Some(&actor),
        )
        .await,
    );
    assert_eq!(missing.status, 404);
    assert_eq!(missing.code, "AML_EVIDENCE_NOT_FOUND");

    cleanup(&state.pools.main, &fixture).await;
}

#[tokio::test]
async fn screenings_and_rules_filters_and_detail() {
    let Some(state) = test_state().await else {
        return;
    };
    let fixture = create_fixture(&state.pools.main).await;
    let actor = principal(fixture.user, "MLRO", &[]);

    let response = screenings_list_impl(
        &state,
        &request(&format!(
            "/internal/admin/aml/screenings?search=TESTPROV-{}&result=POTENTIAL_MATCH&scoreMin=90&sortKey=score&sortDirection=desc",
            fixture.suffix
        )),
        Some(&actor),
    )
    .await
    .expect("screenings");
    let value = body(response).await;
    assert_eq!(value["total"], json!(1));
    assert_eq!(
        value["screenings"][0]["id"],
        json!(fixture.screening_open.to_string())
    );
    assert_eq!(value["screenings"][0]["score"], json!("95.5000"));
    assert_eq!(
        value["screenings"][0]["dispositionSummary"]["unreviewed"],
        json!(1)
    );
    assert_eq!(
        value["screenings"][0]["dispositionSummary"]["falsePositive"],
        json!(1)
    );
    assert_eq!(value["screenings"][0]["matchCount"], json!(2));
    assert!(value["screenings"][0]["matchId"].is_string());

    let response = screening_detail_impl(
        &state,
        &request(&format!(
            "/internal/admin/aml/screenings/{}",
            fixture.screening_open
        )),
        Some(&actor),
    )
    .await
    .expect("screening detail");
    let value = body(response).await;
    assert_eq!(
        value["screening"]["matches"][0]["listType"],
        json!("SANCTIONS")
    );
    assert_eq!(value["screening"]["matches"][0]["score"], json!("95.0000"));
    assert_eq!(value["screening"]["canDisposition"], json!(true));
    assert_eq!(
        value["screening"]["subjectName"],
        json!(format!("AML Test Trade {}", fixture.suffix))
    );

    let response = rules_list_impl(
        &state,
        &request(&format!(
            "/internal/admin/aml/rules?search={}&active=true&ruleType=SINGLE_AMOUNT&versionMin=1&sortKey=name",
            fixture.suffix
        )),
        Some(&actor),
    )
    .await
    .expect("rules");
    let value = body(response).await;
    assert_eq!(value["total"], json!(1));
    assert_eq!(value["rules"][0]["id"], json!(fixture.rule.to_string()));
    assert_eq!(value["rules"][0]["pendingApproval"], json!(false));

    let response = rule_detail_impl(
        &state,
        &request(&format!("/internal/admin/aml/rules/{}", fixture.rule)),
        Some(&actor),
    )
    .await
    .expect("rule detail");
    let value = body(response).await;
    assert_eq!(
        value["rule"]["code"],
        json!(format!("TEST_RULE_{}", fixture.suffix))
    );
    assert_eq!(value["rule"]["approval"], Value::Null);
    assert_eq!(value["rule"]["approvalRequest"], Value::Null);

    // Reporting rules include our row with a decimal.js threshold.
    let response = reporting_rules_impl(
        &state,
        &request("/internal/admin/aml/reporting-rules"),
        Some(&actor),
    )
    .await
    .expect("reporting rules");
    let value = body(response).await;
    let row = value["rules"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|row| row["id"] == json!(fixture.reporting_rule.to_string()))
        })
        .expect("fixture reporting rule");
    assert_eq!(row["thresholdAmount"], json!("10000"));
    assert_eq!(row["requiredOutputFormats"], json!(["XML"]));

    cleanup(&state.pools.main, &fixture).await;
}

#[tokio::test]
async fn regulatory_schemas_reports_filing_and_downloads() {
    let Some(state) = test_state().await else {
        return;
    };
    let fixture = create_fixture(&state.pools.main).await;
    let actor = principal(fixture.user, "MLRO", &[]);

    let response = report_schemas_impl(
        &state,
        &request("/internal/admin/aml/report-schemas"),
        Some(&actor),
    )
    .await
    .expect("schemas");
    let value = body(response).await;
    let row = value["schemas"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|row| row["id"] == json!(fixture.schema_xml.to_string()))
        })
        .expect("fixture schema");
    assert_eq!(row["paths"], json!(2));
    assert_eq!(row["codeLists"], json!(1));
    assert_eq!(row["rootElement"], json!("Report"));

    let response = report_schema_detail_impl(
        &state,
        &request(&format!(
            "/internal/admin/aml/report-schemas/{}",
            fixture.schema_xml
        )),
        Some(&actor),
    )
    .await
    .expect("schema detail");
    let value = body(response).await;
    assert_eq!(value["schema"]["id"], json!(fixture.schema_xml.to_string()));
    assert_eq!(value["usage"]["defaultBindings"], json!(1));
    assert_eq!(value["usage"]["ruleBindings"], json!(1));
    assert_eq!(value["capabilities"]["edit"], json!(false));
    assert_eq!(value["capabilities"]["setDefault"], json!(true));

    // Template download decrypts the legacy ciphertext and audits.
    let response = report_schema_template_impl(
        &state,
        &request(&format!(
            "/internal/admin/aml/report-schemas/{}/template",
            fixture.schema_template
        )),
        Some(&actor),
    )
    .await
    .expect("template");
    let value = body(response).await;
    assert_eq!(
        value["templateBase64"],
        json!(base64_encode(b"PK\x03\x04test-template"))
    );

    // Rule bindings, defaults and requirements.
    let response = reporting_rule_bindings_impl(
        &state,
        &request(&format!(
            "/internal/admin/aml/reporting-rules/{}/schema-bindings",
            fixture.reporting_rule
        )),
        Some(&actor),
    )
    .await
    .expect("bindings");
    let value = body(response).await;
    assert_eq!(value["bindings"][0]["format"], json!("XML"));
    assert_eq!(
        value["bindings"][0]["schema"]["id"],
        json!(fixture.schema_xml.to_string())
    );

    let response = report_schema_defaults_impl(
        &state,
        &request("/internal/admin/aml/report-schema-defaults"),
        Some(&actor),
    )
    .await
    .expect("defaults");
    let value = body(response).await;
    let binding = value["bindings"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|row| row["schemaId"] == json!(fixture.schema_xml.to_string()))
        })
        .expect("fixture default binding");
    assert_eq!(binding["format"], json!("XML"));

    let response = report_requirements_impl(
        &state,
        &request(&format!(
            "/internal/admin/aml/reports/{}/requirements",
            fixture.report_rule
        )),
        Some(&actor),
    )
    .await
    .expect("requirements");
    let value = body(response).await;
    assert_eq!(value["requirements"][0]["format"], json!("XML"));
    assert_eq!(value["requirements"][0]["paths"], json!(2));
    assert_eq!(value["requirements"][0]["codeLists"], json!(1));
    assert_eq!(value["requirements"][0]["editable"], json!(true));
    assert_eq!(value["narrative"]["riskAssessment"], json!("ok"));
    assert_eq!(value["pending"], json!(["summary"]));

    let response = report_payload_impl(
        &state,
        &request(&format!(
            "/internal/admin/aml/reports/{}/payload",
            fixture.report_rule
        )),
        Some(&actor),
    )
    .await
    .expect("payload");
    let value = body(response).await;
    assert_eq!(value["reportId"], json!(fixture.report_rule.to_string()));
    assert_eq!(value["narrative"]["riskAssessment"], json!("ok"));
    assert_eq!(value["outputs"][0]["format"], json!("XML"));
    assert_eq!(
        value["outputs"][0]["id"],
        json!(fixture.output_xml.to_string())
    );

    // Report list filters + incident subject name.
    let response = reports_list_impl(
        &state,
        &request(&format!(
            "/internal/admin/aml/reports?search={}&status=DRAFT&reportType=LARGE_TRANSACTION&authority=CBL&amlCaseId={}",
            fixture.suffix, fixture.case_open
        )),
        Some(&actor),
    )
    .await
    .expect("reports list");
    let value = body(response).await;
    assert_eq!(value["total"], json!(1));
    assert_eq!(
        value["reports"][0]["id"],
        json!(fixture.report_rule.to_string())
    );
    assert_eq!(
        value["reports"][0]["subjectName"],
        json!(format!("Test reporting rule {}", fixture.suffix))
    );

    // Cursor on createdAt across our two reports (search matches both submission refs).
    let response = reports_list_impl(
        &state,
        &request(
            "/internal/admin/aml/reports?search=TEST-SUB&sortKey=createdAt&sortDirection=desc&pageSize=1",
        ),
        Some(&actor),
    )
    .await
    .expect("reports cursor");
    let value = body(response).await;
    assert!(value["nextCursor"].is_string());

    // Report detail for the incident report names the incident.
    let response = report_detail_impl(
        &state,
        &request(&format!(
            "/internal/admin/aml/reports/{}",
            fixture.report_incident
        )),
        Some(&actor),
    )
    .await
    .expect("report detail");
    let value = body(response).await;
    assert_eq!(
        value["report"]["id"],
        json!(fixture.report_incident.to_string())
    );
    assert_eq!(value["report"]["subjectType"], json!("INCIDENT"));
    assert!(value["report"]["subjectName"]
        .as_str()
        .is_some_and(|name| name.contains(&fixture.suffix)));

    // Output download: authority gate, hash, headers.
    let finance = principal(fixture.user, "FINANCE", &["aml:read"]);
    let denied = error(
        report_output_download_impl(
            &state,
            &request(&format!(
                "/internal/admin/aml/reports/{}/outputs/XML/download",
                fixture.report_rule
            )),
            Some(&finance),
        )
        .await,
    );
    assert_eq!(denied.status, 403);
    assert_eq!(denied.code, "REPORTING_AUTHORITY_REQUIRED");
    let response = report_output_download_impl(
        &state,
        &request(&format!(
            "/internal/admin/aml/reports/{}/outputs/XML/download",
            fixture.report_rule
        )),
        Some(&actor),
    )
    .await
    .expect("output download");
    assert_eq!(response.status(), ntex::http::StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("X-Content-SHA256")
            .and_then(|value| value.to_str().ok()),
        Some(sha256_hex(b"<Report/>").as_str())
    );
    let bytes = test::read_body(response).await;
    assert_eq!(&bytes[..], b"<Report/>");

    // Filing adapters (redacted config) and submissions.
    let response = filing_adapters_impl(
        &state,
        &request("/internal/admin/aml/filing-adapters"),
        Some(&actor),
    )
    .await
    .expect("filing adapters");
    let value = body(response).await;
    let adapter = value["adapters"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|row| row["id"] == json!(fixture.adapter.to_string()))
        })
        .expect("fixture adapter");
    assert_eq!(adapter["configJson"]["apiKey"], json!("[redacted]"));
    assert_eq!(adapter["configJson"]["endpoint"], json!("x"));

    let response = report_submissions_impl(
        &state,
        &request(&format!(
            "/internal/admin/aml/reports/{}/submissions",
            fixture.report_rule
        )),
        Some(&actor),
    )
    .await
    .expect("submissions");
    let value = body(response).await;
    assert_eq!(
        value["submissions"][0]["adapter"]["id"],
        json!(fixture.adapter.to_string())
    );

    // 404s for the regulatory resources.
    for result in [
        report_schema_detail_impl(
            &state,
            &request(&format!(
                "/internal/admin/aml/report-schemas/{}",
                Uuid::new_v4()
            )),
            Some(&actor),
        )
        .await
        .err(),
        report_payload_impl(
            &state,
            &request(&format!(
                "/internal/admin/aml/reports/{}/payload",
                Uuid::new_v4()
            )),
            Some(&actor),
        )
        .await
        .err(),
        report_detail_impl(
            &state,
            &request(&format!("/internal/admin/aml/reports/{}", Uuid::new_v4())),
            Some(&actor),
        )
        .await
        .err(),
        rule_detail_impl(
            &state,
            &request(&format!("/internal/admin/aml/rules/{}", Uuid::new_v4())),
            Some(&actor),
        )
        .await
        .err(),
    ] {
        assert_eq!(result.map(|error| error.status), Some(404));
    }

    cleanup(&state.pools.main, &fixture).await;
}

#[tokio::test]
async fn exports_summaries_and_audit_rows() {
    let Some(state) = test_state().await else {
        return;
    };
    let fixture = create_fixture(&state.pools.main).await;
    let actor = principal(fixture.user, "COMPLIANCE", &[]);

    let response = screenings_summary_impl(
        &state,
        &request("/internal/admin/aml/screenings/summary"),
        Some(&actor),
    )
    .await
    .expect("screening summary");
    let value = body(response).await;
    assert!(value["total"].as_i64().unwrap_or_default() >= 2);
    assert!(value["byResult"].is_object());

    let response = cases_summary_impl(
        &state,
        &request("/internal/admin/aml/cases/summary"),
        Some(&actor),
    )
    .await
    .expect("case summary");
    let value = body(response).await;
    assert!(value["totalOpen"].as_i64().unwrap_or_default() >= 1);
    assert!(value["byStatus"].is_object());
    assert!(value["oldestOpenAgeHours"].is_number());

    let response = rules_summary_impl(
        &state,
        &request("/internal/admin/aml/rules/summary"),
        Some(&actor),
    )
    .await
    .expect("rule summary");
    let value = body(response).await;
    assert!(value["active"].as_i64().unwrap_or_default() >= 1);

    let response = reports_summary_impl(
        &state,
        &request("/internal/admin/aml/reports/summary"),
        Some(&actor),
    )
    .await
    .expect("report summary");
    let value = body(response).await;
    assert!(value["total"].as_i64().unwrap_or_default() >= 2);
    assert!(value["submittedThisMonth"].is_number());

    // Exports return the fixture rows and write their audit rows.
    let response = screenings_export_impl(
        &state,
        &request(&format!(
            "/internal/admin/aml/screenings/export?search=TESTPROV-{}&result=POTENTIAL_MATCH&checklist=SCREENING_SCOPE_VERIFIED",
            fixture.suffix
        )),
        Some(&actor),
    )
    .await
    .expect("screenings export");
    let value = body(response).await;
    assert_eq!(value["exported"], json!(1));
    assert_eq!(value["truncated"], json!(false));

    let response = cases_export_impl(
        &state,
        &request(&format!(
            "/internal/admin/aml/cases/export?search={}",
            fixture.suffix
        )),
        Some(&actor),
    )
    .await
    .expect("cases export");
    let value = body(response).await;
    assert_eq!(value["exported"], json!(2));

    let response = rules_export_impl(
        &state,
        &request(&format!(
            "/internal/admin/aml/rules/export?search={}",
            fixture.suffix
        )),
        Some(&actor),
    )
    .await
    .expect("rules export");
    let value = body(response).await;
    assert_eq!(value["exported"], json!(1));

    let response = reports_export_impl(
        &state,
        &request(
            "/internal/admin/aml/reports/export?search=TEST-SUB&checklist=REPORT_SCOPE_VERIFIED",
        ),
        Some(&actor),
    )
    .await
    .expect("reports export");
    let value = body(response).await;
    assert!(value["exported"].as_i64().unwrap_or_default() >= 2);

    let response = screenings_summary_export_impl(
        &state,
        &request("/internal/admin/aml/screenings/summary/export"),
        Some(&actor),
    )
    .await
    .expect("screenings summary export");
    let value = body(response).await;
    assert!(value["exportedAt"].is_string());

    let response = cases_summary_export_impl(
        &state,
        &request("/internal/admin/aml/cases/summary/export"),
        Some(&actor),
    )
    .await
    .expect("cases summary export");
    let value = body(response).await;
    assert!(value["exportedAt"].is_string());

    let response = rules_summary_export_impl(
        &state,
        &request("/internal/admin/aml/rules/summary/export"),
        Some(&actor),
    )
    .await
    .expect("rules summary export");
    let value = body(response).await;
    assert!(value["exportedAt"].is_string());

    let response = reports_summary_export_impl(
        &state,
        &request("/internal/admin/aml/reports/summary/export"),
        Some(&actor),
    )
    .await
    .expect("reports summary export");
    let value = body(response).await;
    assert!(value["exportedAt"].is_string());

    // The export handlers wrote audited rows for this actor.
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE actor_id = $1 AND action LIKE 'AML_%'",
    )
    .bind(fixture.user)
    .fetch_one(&state.pools.main)
    .await
    .expect("audit rows");
    assert!(
        count >= 8,
        "expected every export to be audited, got {count}"
    );

    cleanup(&state.pools.main, &fixture).await;
}

#[tokio::test]
async fn report_context_catalog_is_complete() {
    let catalog = report_context_catalog_value();
    assert_eq!(
        catalog["transformOperations"].as_array().map(Vec::len),
        Some(39)
    );
    assert_eq!(
        catalog["sourceKinds"],
        json!(["CONTEXT_PATH", "CONSTANT", "CODE_MAP", "TEMPLATE"])
    );
    assert_eq!(
        catalog["conditionOperators"],
        json!(["EQ", "NEQ", "IN", "NOT_EMPTY", "GT"])
    );
    assert_eq!(catalog["arrays"]["transactions"], json!("transaction"));
}

#[test]
fn route_table_resolves_static_and_dynamic_paths() {
    let routes = routes();
    assert_eq!(routes.len(), 34);
    assert_eq!(
        resolve(
            "GET",
            "/internal/admin/aml/cases/00000000-0000-4000-8000-000000000001"
        )
        .map(|resolved| resolved.route.policy.path),
        Some("/internal/admin/aml/cases/:id".to_owned())
    );
    assert_eq!(
        resolve(
            "GET",
            "/internal/admin/aml/cases/00000000-0000-4000-8000-000000000001/evidence"
        )
        .map(|resolved| resolved.route.policy.path),
        Some("/internal/admin/aml/cases/:id/evidence".to_owned())
    );
    assert_eq!(
        resolve("GET", "/internal/admin/aml/cases/summary")
            .map(|resolved| resolved.route.policy.path),
        Some("/internal/admin/aml/cases/summary".to_owned())
    );
    assert!(resolve("POST", "/internal/admin/aml/cases").is_none());
    assert!(resolve("GET", "/internal/admin/aml/nope").is_none());
    for route in &routes {
        assert_eq!(route.policy.channel, pg_http::Channel::Admin);
        assert_eq!(route.policy.authn, pg_http::Authn::Session);
        assert_eq!(route.guard, PrincipalGuard::Staff);
        assert!(!route.policy.ts_origin.trim().is_empty());
    }
}

#[test]
fn confidentiality_rule_matches_the_ts_helper() {
    let user = Uuid::new_v4();
    assert!(has_confidential_aml_access(&principal(
        user,
        "COMPLIANCE",
        &[]
    )));
    assert!(has_confidential_aml_access(&principal(user, "MLRO", &[])));
    assert!(has_confidential_aml_access(&principal(
        user,
        "FINANCE",
        &["aml:read"]
    )));
    assert!(has_confidential_aml_access(&principal(
        user,
        "FINANCE",
        &["aml:write"]
    )));
    assert!(has_confidential_aml_access(&principal(
        user,
        "FINANCE",
        &["*"]
    )));
    assert!(!has_confidential_aml_access(&principal(
        user,
        "FINANCE",
        &["compliance:read"]
    )));
    assert!(!has_confidential_aml_access(&principal(
        user,
        "SUPPORT",
        &[]
    )));
}

#[test]
fn content_disposition_matches_the_ts_rfc5986_shape() {
    assert_eq!(
        content_disposition("attachment", Some("bank statement.pdf"), "evidence"),
        "attachment; filename=\"bank statement.pdf\""
    );
    assert!(
        content_disposition("attachment", Some("كشف.pdf"), "evidence")
            .contains("filename*=UTF-8''%D9%83%D8%B4%D9%81.pdf")
    );
    assert_eq!(
        content_disposition("attachment", None, "evidence"),
        "attachment; filename=\"evidence\""
    );
}

#[test]
fn base64_helpers_round_trip() {
    for bytes in [b"".as_slice(), b"a", b"ab", b"abc", b"\x00\xff\x10"] {
        let encoded = base64_encode(bytes);
        assert_eq!(base64_decode(&encoded).as_deref(), Some(bytes));
    }
}

#[test]
fn fixture_dates_are_utc() {
    let date = NaiveDate::from_ymd_opt(2026, 11, 28).expect("date");
    assert_eq!(super::view::iso_date(date), "2026-11-28T00:00:00.000Z");
}
