# Declarative Regulatory Reporting Engine — Final Design

Status: implementation design
Audience: `core-back`, `admin-back`, `admin-front`, compliance operations
Supersedes: the format model and submission gate of `declarative_goaml_xsd_reporting_engine_plan.md` while retaining that document's XSD compiler, AST, mapping and security design.

## 1. Purpose

Build one declarative regulatory reporting engine that can generate, validate, version, approve and file every report in the CBL catalogue:

- goAML XML reports validated against an uploaded XSD (`STR`, `LTR`).
- XLSX returns generated from an uploaded CBL workbook or a declarative workbook schema (`PSP-M`, `AML-Q`, `AML-A`).
- Reports that have more than one output (`LTR`, `AML-A`) from one canonical report context.
- Narrative sections completed by the MLRO inside the report and included in the workbook/hash.
- All outputs versioned, encrypted at rest, SHA-256 pinned, audited and immutable after approval.
- Filing remains a human action. The engine never uploads to the FIU/CBL.

`INC` is deferred until incident management exists. It will use the same engine when it is built.

## 2. Non-goals

- No automatic filing or submission to any authority.
- No DOCX/PDF generation in the first implementation; narrative is a structured section set rendered in the XLSX and the report drawer. A later renderer can reuse the same narrative schema.
- No external XSD/XML parser that resolves entities, imports or network URLs.
- No client-side generation of the authoritative filing file. The server generates the file that is hashed and filed.
- No merchant-visible regulatory content. Regulatory reports are confidential.

## 3. Core design principles

1. **Format is a first-class dimension.** A report may have XML, XLSX and narrative outputs. Submission gates are evaluated per required output.
2. **One canonical context.** XML and XLSX mapping blueprints read the same `CanonicalReportContext`.
3. **Declarative, versioned schemas.** XML schemas use XSD + compiled AST; XLSX schemas use a declarative workbook JSON and/or an uploaded CBL workbook. Both are stored, hashed, versioned and four-eyes promoted.
4. **Server-side authoritative files.** The server generates, encrypts, hashes and stores the filing file. The admin UI downloads that exact file.
5. **Draft is editable; approved is immutable.** Schema versions are immutable once `CONFIRMED`; report outputs are immutable once the report is approved/submitted.
6. **Fail closed.** Missing/provisional schema, missing required output, invalid XML/XLSX, or incomplete narrative blocks filing.
7. **Four-eyes everywhere it matters.** Schema promotion/default binding and report approval require maker != checker with the correct domain authority.
8. **No secrets in logs.** Payloads, XML, XLSX, national IDs and narratives are never logged.

## 4. Report and format matrix

| Report code | Type | Primary filing output | Other outputs | Schema contract | Filing channel |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `STR` | `SUSPICIOUS_ACTIVITY` | XML | — | Confirmed XSD | FIU goAML XML |
| `LTR` | `LARGE_TRANSACTION` | XML | XLSX (supporting) | Confirmed XSD; confirmed XLSX template if required | FIU goAML + XLSX copy |
| `PSP-M` | `PERIODIC_RETURN` | XLSX | — | Confirmed XLSX template/schema | CBL Payment Systems |
| `AML-Q` | `PERIODIC_RETURN` | XLSX | — | Confirmed XLSX template/schema | CBL compliance/supervision |
| `AML-A` | `PERIODIC_RETURN` | XLSX | Narrative sections | Confirmed XLSX template; narrative schema | CBL compliance/supervision |
| `INC` | `PERIODIC_RETURN` | deferred | deferred | deferred | deferred until incident management |

`ReportingRule.requiredOutputFormats` and `primaryOutputFormat` are data, not code. A format can be added later without changing the engine.

## 5. Architecture

```
                         +------------------------------------------+
                         |        Admin Reporting Studio            |
                         |  /aml/reporting-studio                   |
                         |  - XSD upload / AST / mapper / simulator  |
                         |  - XLSX template / workbook schema        |
                         |  - narrative sections                    |
                         |  - versioning / promotion / defaults     |
                         +---------------------+--------------------+
                                               |
                                               v
+------------------------------+     +------------------------------+
| ReportingRuleEvaluator /     |     |  RegulatoryReportSchema      |
| RegulatoryReportWorker       |---->|  registry + bindings         |
| - schedule / threshold rules |     +--------------+---------------+
+--------------+---------------+                    |
               |                                    |
               v                                    v
+------------------------------+     +------------------------------+
| CanonicalReportContext       |---->|  Generation service          |
| - attempt / case / merchant  |     |  - XML renderer (XSD AST)    |
| - aggregates / narrative     |     |  - XLSX renderer (ExcelJS)   |
+--------------+---------------+     |  - narrative validation      |
               |                     +--------------+---------------+
               v                                    |
+------------------------------+                    v
| RegulatoryReport DRAFT       |     +------------------------------+
| - encrypted canonical JSON   |     | RegulatoryReportOutput       |
| - required formats snapshot  |     | - encrypted XML/XLSX         |
+--------------+---------------+     | - SHA-256 / status / errors  |
               |                     +--------------+---------------+
               v                                    |
+------------------------------+                    v
| Approval (maker-checker)     |---->| Human filing + reference     |
+------------------------------+     +------------------------------+
```

## 6. Data model

Schema versions 28+ (the report-engine SDK owns versions 26 and 27; the first version of this design was drafted against version 25). The final model generalizes section 2.1 of the XSD plan.

### 6.1 Enums

```prisma
enum ReportOutputFormat {
  XML
  XLSX
}

enum RegulatorySchemaStatus {
  DRAFT
  PROVISIONAL
  PENDING_APPROVAL
  CONFIRMED
  SUPERSEDED
  ARCHIVED
}

enum ReportOutputValidationStatus {
  NOT_GENERATED
  PROVISIONAL_SCHEMA
  VALIDATED
  INVALID
}
```

`NARRATIVE` is a structured section set, not a separate file in this phase. It is stored in the report payload and the XLSX narrative sheet. A future `DOCX`/`PDF` output can add a new format enum value.

### 6.2 `RegulatoryReportSchema`

One registry for every format.

```prisma
model RegulatoryReportSchema {
  id                    String                 @id @default(uuid(7)) @db.Uuid
  createdAt             DateTime               @default(now()) @map("created_at")
  updatedAt             DateTime               @updatedAt @map("updated_at")

  authority             String                 @db.Text
  reportType            ReportingType          @map("report_type")
  reportCode            String                 @default("") @map("report_code") @db.Text
  format                ReportOutputFormat
  schemaCode            String                 @map("schema_code") @db.Text
  name                  String                 @db.Text
  version               Int                    @default(1)
  status                RegulatorySchemaStatus @default(DRAFT)

  /// XSD XML text for XML schemas; declarative workbook JSON for XLSX schemas.
  definitionText        String?                @map("definition_text") @db.Text
  definitionSha256      String?                @map("definition_sha256") @db.Char(64)

  /// Uploaded .xlsx template, encrypted at rest; null when generated from the schema.
  templateCiphertext    String?                @map("template_ciphertext") @db.Text
  templateSha256        String?                @map("template_sha256") @db.Char(64)

  /// XSD AST for XML; parsed workbook/column model for XLSX.
  compiledDefinitionJson Json                  @map("compiled_definition_json")
  /// Declarative field bindings, transforms, code maps, repeat nodes and validations.
  mappingBlueprintJson  Json                   @map("mapping_blueprint_json")
  sampleContextJson     Json?                  @map("sample_context_json")

  notes                 String?                @db.Text
  createdByUserId       String?                @map("created_by_user_id") @db.Uuid
  approvedByUserId      String?                @map("approved_by_user_id") @db.Uuid
  approvedAt            DateTime?              @map("approved_at")
  approvalRequestId     String?                @map("approval_request_id") @db.Uuid
  seedKey               String?                @unique @map("seed_key")

  approvalRequest       ApprovalRequest?       @relation("RegulatorySchemaApproval", fields: [approvalRequestId], references: [id], onDelete: SetNull)
  defaultBindings       RegulatorySchemaDefaultBinding[]
  ruleBindings          RegulatoryRuleSchemaBinding[]
  reportOutputs         RegulatoryReportOutput[]

  @@unique([authority, schemaCode, version])
  @@index([authority, reportType, format, status])
  @@index([schemaCode, version])
  @@map("regulatory_report_schemas")
}
```

### 6.3 Default and rule bindings

```prisma
model RegulatorySchemaDefaultBinding {
  id                String              @id @default(uuid(7)) @db.Uuid
  createdAt         DateTime            @default(now()) @map("created_at")
  updatedAt         DateTime            @updatedAt @map("updated_at")
  authority         String              @db.Text
  reportType        ReportingType       @map("report_type")
  reportCode        String              @default("") @map("report_code") @db.Text
  format            ReportOutputFormat
  schemaId          String              @map("schema_id") @db.Uuid
  updatedByUserId   String?             @map("updated_by_user_id") @db.Uuid
  approvalRequestId String?             @map("approval_request_id") @db.Uuid

  schema            RegulatoryReportSchema @relation(fields: [schemaId], references: [id], onDelete: Restrict)

  @@unique([authority, reportType, reportCode, format])
  @@map("regulatory_schema_default_bindings")
}

model RegulatoryRuleSchemaBinding {
  id        String              @id @default(uuid(7)) @db.Uuid
  ruleId    String              @map("rule_id") @db.Uuid
  format    ReportOutputFormat
  schemaId  String              @map("schema_id") @db.Uuid
  createdAt DateTime            @default(now()) @map("created_at")

  rule      ReportingRule       @relation(fields: [ruleId], references: [id], onDelete: Cascade)
  schema    RegulatoryReportSchema @relation(fields: [schemaId], references: [id], onDelete: Restrict)

  @@unique([ruleId, format])
  @@map("regulatory_rule_schema_bindings")
}
```

### 6.4 Additions to `ReportingRule`

```prisma
model ReportingRule {
  // existing fields
  requiredOutputFormats ReportOutputFormat[] @default([XML]) @map("required_output_formats")
  primaryOutputFormat   ReportOutputFormat?  @map("primary_output_format")
  schemaBindings        RegulatoryRuleSchemaBinding[]
}
```

For a scheduled rule, `requiredOutputFormats` comes from the report code matrix when the migration seeds the catalogue. A rule can override it.

### 6.5 Additions to `RegulatoryReport`

```prisma
model RegulatoryReport {
  // existing fields
  requiredOutputFormats ReportOutputFormat[] @map("required_output_formats")
  filingChannel         String?              @map("filing_channel")
  acknowledgedAt        DateTime?            @map("acknowledged_at")
  rejectionReason       String?              @map("rejection_reason") @db.Text
  supersedesId          String?              @map("supersedes_id") @db.Uuid
  outputs               RegulatoryReportOutput[]
}
```

### 6.6 `RegulatoryReportOutput`

```prisma
model RegulatoryReportOutput {
  id                    String                       @id @default(uuid(7)) @db.Uuid
  createdAt             DateTime                     @default(now()) @map("created_at")
  updatedAt             DateTime                     @updatedAt @map("updated_at")

  reportId              String                       @map("report_id") @db.Uuid
  format                ReportOutputFormat
  revision              Int                          @default(1)
  schemaId              String?                      @map("schema_id") @db.Uuid
  schemaVersion         Int?                         @map("schema_version")

  contentCiphertext     String                       @map("content_ciphertext") @db.Text
  contentSha256         String                       @map("content_sha256") @db.Char(64)
  validationStatus      ReportOutputValidationStatus @default(NOT_GENERATED) @map("validation_status")
  validationErrorsJson  Json?                        @map("validation_errors_json")

  generatedAt           DateTime?                    @map("generated_at")
  generatedByUserId     String?                      @map("generated_by_user_id") @db.Uuid
  supersededAt          DateTime?                    @map("superseded_at")
  submittedAt           DateTime?                    @map("submitted_at")

  report                RegulatoryReport             @relation(fields: [reportId], references: [id], onDelete: Cascade)
  schema                RegulatoryReportSchema?      @relation(fields: [schemaId], references: [id], onDelete: Restrict)

  @@unique([reportId, format, revision])
  @@index([reportId, format, supersededAt])
  @@map("regulatory_report_outputs")
}
```

### 6.7 Schema parity

- Move the existing partial unique index `(report_code, period_key)` and the due-date index into `schema.prisma` so Prisma does not lose them.
- Add an immutability trigger for confirmed schemas and approved/submitted report outputs, or enforce in the service plus a database trigger (preferred).
- Add a unique partial index for exactly one current output per `(reportId, format)` where `superseded_at IS NULL`.

## 7. Canonical report context

`CanonicalReportContextBuilder` is format-neutral. It hydrates:

- `institution`: `rentityId`, `rentityBranch`, `submissionCode`, `localCurrencyCode`, reporting officer identity.
- `report`: id, reference, type, code, authority, period, due date, required formats.
- `merchant`: legal/trade name, registration, tax, business category, country, status, KYB, risk tier, payout bank, beneficial owners (decrypted only inside `core-back`).
- `wallet` / `glAccount`: wallet id, currency, sharded live balance.
- `transactions[]`: attempt and payer fields.
- `amlCase` / `indicators[]`: linked case, rule, screening matches, narrative inputs.
- `aggregates`: periodic-return sections.
- `narrative`: structured sections.

The builder never logs decrypted values. It uses existing repositories and read-only SQL. It must be deterministic for a given report revision (timestamps and totals are captured once).

## 8. XML renderer (XSD)

Retain the design in `declarative_goaml_xsd_reporting_engine_plan.md`:

1. `XsdCompiler.compile(xsdXml)`:
   - size cap 2 MB;
   - reject `<!DOCTYPE`, `<!ENTITY`, external `SYSTEM`/`PUBLIC`, remote `schemaLocation` imports/includes/redefines;
   - parse `xs:schema` into a deterministic AST: elements, sequences, choices, all, min/maxOccurs, types, facets, enumerations, attributes, documentation;
   - cap nesting depth and repeat count.
2. `mappingBlueprintJson`:
   - `fieldBindings`: xsdPath -> context path/constant/code map/template, transforms, condition;
   - `repeatingNodes`: xsdPath -> context array + item alias;
   - `codeMaps`: internal values -> XSD enumeration values;
   - `assertions`: cross-field requirements.
3. `XsdXmlGenerator`:
   - walks AST in `sequenceOrder`, never mapping order;
   - escapes XML text and attributes;
   - enforces max repeat counts;
   - emits XML declaration and root.
4. `XsdXmlValidator`:
   - required elements, cardinality, types, facets, patterns, enumerations, assertions;
   - returns path-level errors.
5. Baseline seeds:
   - `cbl-goaml-str-v1` (`SUSPICIOUS_ACTIVITY`, XML, PROVISIONAL)
   - `cbl-goaml-ltr-v1` (`LARGE_TRANSACTION`, XML, PROVISIONAL)
   - `cbl-goaml-return-v1` (`PERIODIC_RETURN`, XML, PROVISIONAL, optional)
   - each has a real W3C XSD modeled on UNODC goAML 5.0 and a complete mapping blueprint.
6. Output status:
   - `VALIDATED` when schema `CONFIRMED` and validation passes;
   - `PROVISIONAL_SCHEMA` when schema `PROVISIONAL` and validation passes;
   - `INVALID` with errors.
7. Submission gate: XML output must be `VALIDATED` with a `CONFIRMED` schema.

## 9. XLSX renderer

### 9.1 Modes

- **Template mode:** upload a CBL `.xlsx`; read sheets, named ranges, headers and styles; fill mapped ranges.
- **Generated mode:** no workbook upload; generate sheets/columns/formats from the declarative workbook JSON.

### 9.2 Declarative workbook JSON

```json
{
  "schemaVersion": 1,
  "mode": "TEMPLATE",
  "sheets": [
    {
      "name": "Summary",
      "order": 0,
      "columns": [
        { "key": "metric", "header": "Metric", "type": "string", "width": 40 },
        { "key": "value", "header": "Value", "type": "number", "numberFormat": "#,##0.0000" }
      ],
      "rows": { "repeatOver": "aggregates.summaryRows" }
    },
    {
      "name": "Transactions",
      "order": 1,
      "columns": [
        { "key": "reference", "header": "Reference", "type": "string", "required": true },
        { "key": "date", "header": "Date", "type": "date", "numberFormat": "yyyy-mm-dd" },
        { "key": "amount", "header": "Amount", "type": "number", "required": true },
        { "key": "currency", "header": "Currency", "type": "string", "required": true }
      ],
      "rows": { "repeatOver": "transactions" },
      "totals": [{ "column": "amount", "function": "sum" }]
    }
  ],
  "narrativeSections": [
    { "key": "riskAssessment", "title": "Risk assessment", "required": true, "maxLength": 8000 }
  ],
  "validations": [
    { "id": "total-settled", "type": "TOTAL_MATCH", "contextPath": "aggregates.totalSettled", "column": "amount" }
  ]
}
```

### 9.3 Server-side generation

- New shared server module `core-back/lib/xlsx/`.
- Use pinned `exceljs` (already used by the portals) for workbook reading, writing and styles.
- The server is the only authoritative generator for regulatory XLSX. The admin UI downloads the server file; it does not convert CSV client-side.
- Encrypt the output with the `reporting-xlsx` Vault key; store SHA-256.
- The existing portal XLSX pipeline remains for ordinary table exports.

### 9.4 XLSX security

- Reject `.xlsm` and macro-bearing files.
- Reject external workbook links, embedded objects and OLE.
- Zip-bomb and cell-count limits; generation time budget.
- Formula injection guard: text starting with `=`, `+`, `-`, `@` is escaped or written as text.
- Validate sheet names, named ranges, columns and totals.
- Template and output access is confidential and audited.

### 9.5 Output status

- `VALIDATED` when all validations pass and the template/schema is `CONFIRMED`.
- `PROVISIONAL_SCHEMA` when generated from a `PROVISIONAL` template.
- `INVALID` with sheet/row/cell errors.

### 9.6 Submission gate

XLSX output must be `VALIDATED` with a `CONFIRMED` template/schema. XLSX-only reports have no XML/XSD requirement; they still have XLSX validation.

## 10. Narrative

- `narrativeSections` in the XLSX workbook schema defines key, title, required, max length and guidance.
- The MLRO fills them in the report drawer while the report is `DRAFT`.
- The text is part of the canonical report payload, the payload SHA-256 and the XLSX output hash.
- AML-A uses a “Narrative” sheet in the XLSX. INC will reuse the same section model when built.
- A separate DOCX/PDF renderer is future work and does not change the schema registry.

## 11. Report lifecycle

1. **Draft**
   - `RegulatoryReportWorker` or `ReportingRuleEvaluator` creates the report and stores the encrypted canonical payload.
   - `requiredOutputFormats` is snapshotted from the rule.
   - `RegulatoryReportGenerationService` resolves a schema per required format:
     - rule binding first;
     - else default binding `(authority, reportType, format)`.
   - It generates each output, validates it, encrypts it, hashes it and writes a `RegulatoryReportOutput` row.
   - If a required schema/template is missing, the report is DRAFT, output is `NOT_GENERATED`, and a case/notice is opened.

2. **Review and approval**
   - The MLRO/compliance views the payload, XML preview, XLSX preview and narrative.
   - “Submit for approval” creates a `REGULATORY_REPORT` approval and sets `PENDING_CHECKER`.
   - The checker approves or rejects. Rejection/expiry returns the report to `DRAFT` and releases the approval.
   - Approval freezes the outputs.

3. **Filing**
   - The submit route records the authority reference and filing channel.
   - It validates every required output:
     - XML: `VALIDATED` + `CONFIRMED` schema.
     - XLSX: `VALIDATED` + `CONFIRMED` template.
     - Narrative: required sections non-empty.
   - Any failure returns `409` with a per-format error list.
   - The MLRO downloads the exact server-generated file, files it, and records the reference.
   - XLSX-only returns submit without any XSD check.

4. **Acknowledgement**
   - `ACKNOWLEDGED` or `REJECTED_BY_AUTHORITY` stores the reason and timestamp.
   - Approved/submitted outputs are immutable.

5. **Regeneration**
   - Only DRAFT/rejected reports.
   - Creates a new output revision; previous revisions become `supersededAt`.
   - Approved/submitted reports are not regenerated in place; a correction is a linked new report.

6. **Deadlines**
   - Every generated report gets `dueAt`.
   - Existing deadline reminders/overdue cases continue.
   - Overdue cases auto-resolve on submit/acknowledge.

## 12. Submission gate matrix

| Output | Gate |
| :--- | :--- |
| XML | `VALIDATED` + schema `CONFIRMED` |
| XLSX | `VALIDATED` + template/schema `CONFIRMED` |
| Narrative | all required sections non-empty |
| `PROVISIONAL_SCHEMA` | never filing-ready |
| `INVALID` / `NOT_GENERATED` | block filing |
| XLSX-only return | no XSD requirement |
| Multi-output return | every required output must pass its own gate |

## 13. Governance and authorities

- Schema list/view: confidential (`MLRO`, `COMPLIANCE`, `aml:read`, `compliance:read`, `report:review`).
- Schema upload/save draft: `assertReportingAuthority`.
- Schema simulate: confidential read.
- Promote schema: maker-checker subject `REGULATORY_REPORT_SCHEMA`; checker must have reporting/AML authority.
- Change default binding: maker-checker when binding a confirmed schema.
- Generate/download report output: `assertReportingAuthority`; audited.
- Request report approval: reporting/AML maker authority.
- Approve report: `approval:check`/`approval:write` plus reporting/AML domain authority; maker != checker.
- Submit/acknowledge: `assertReportingAuthority`; submit also requires checker/maker separation where an approval exists.

Seed and UI authorities must be fixed so COMPLIANCE/MLRO can actually open `/aml/reports`, `/aml/reporting-studio` and `/approvals`.

## 14. API surface

Core (`/internal/admin`):

- `GET /aml/report-schemas`
- `GET /aml/report-schemas/:id`
- `POST /aml/report-schemas` (upload XSD or save XLSX JSON)
- `PUT /aml/report-schemas/:id` (DRAFT/PROVISIONAL only)
- `POST /aml/report-schemas/:id/compile`
- `POST /aml/report-schemas/:id/simulate`
- `POST /aml/report-schemas/:id/promote`
- `GET /aml/report-schema-defaults`
- `PUT /aml/report-schema-defaults`
- `GET /aml/reports/:id/outputs`
- `POST /aml/reports/:id/generate-output`
- `GET /aml/reports/:id/outputs/:format/download`
- `GET /aml/reports/:id/payload`
- `PATCH /aml/reports/:id/payload` (narrative/pending sections only, DRAFT/PENDING_CHECKER)
- `POST /aml/reports/:id/request-approval`
- `GET /aml/reports/:id` (include output summaries)
- `POST /aml/reports/:id/submit`
- `POST /aml/reports/:id/acknowledge`

Admin-back proxies all of the above; no merchant/checkout exposure.

## 15. Admin UI

### 15.1 Reporting Studio

- `/aml/reporting-studio` with tabs:
  - Default schemas per authority/report type/format.
  - Schema registry (XML/XLSX, version, status, hash).
  - XML Studio: upload XSD, AST inspector, field mapper, code lists, simulator.
  - XLSX Studio: upload template or generated workbook, sheet/column mapper, totals, validations, preview.
  - Narrative schema.
  - Promotion/default binding.
- Provisional banners everywhere.
- Schema versions immutable after confirmation.

### 15.2 Report drawer

- Outputs cards per format:
  - schema/template version and hash;
  - validation status and errors;
  - preview and download;
  - regenerate (DRAFT only).
- Submission button gated by required outputs.
- Narrative editor for AML-A.
- Due date, report code, period key, overdue badge.
- Link to the approval and schema.

### 15.3 Rules page

- required/primary output formats;
- per-format schema binding or default;
- period/batch/due days/sections;
- create/edit/retire through maker-checker.

## 16. Migration and seed plan

1. Migration after schema version 25:
   - enums/models/columns/indexes;
   - `required_output_formats` on rules/reports;
   - report output table;
   - schema registry and bindings;
   - acknowledgment/rejection/supersedes fields;
   - immutability triggers;
   - schema parity for existing partial indexes.
2. Seed:
   - provisional XML schemas: `cbl-goaml-str-v1`, `cbl-goaml-ltr-v1`, `cbl-goaml-return-v1`;
   - provisional XLSX schemas: `cbl-psp-m-v1`, `cbl-aml-q-v1`, `cbl-aml-a-v1`;
   - default bindings for CBL/report type/format;
   - reporting rule format matrix;
   - remove duplicate legacy LTR rule.
3. Backfill:
   - existing reports get required formats from report code;
   - existing manual payloads re-encrypted;
   - approved/submitted legacy reports marked `LEGACY` and cannot be re-gated;
   - draft reports can generate outputs on demand.

## 17. Security

- XSD: 2 MB cap, XXE/entity/external import rejection, nesting/repeat caps, no network.
- XML: escape text/attributes, cap output size, reject DTD/external entities.
- XLSX: macro/external-link/OLE rejection, zip-bomb/cell limits, formula-injection guard, sheet/range validation.
- Output encryption: Vault keys `reporting-payload`, `reporting-xml`, `reporting-xlsx`.
- Hash verification on download; audit download.
- Confidentiality: no payload/XML/XLSX/narrative outside confidential routes or logs.
- Four-eyes: schema promotion, default binding, report approval.
- No auto-filing.

## 18. Testing plan

XML:
1. Reject DOCTYPE/ENTITY/external schemaLocation.
2. Compile baseline STR/LTR XSDs; verify sequence/cardinality/facets/enums.
3. Mapping order does not affect XML order.
4. XML escaping.
5. Code-map translation and unmapped enum error.
6. Missing mandatory element.
7. Cross-field assertion.
8. Automated generation with provisional schema → `PROVISIONAL_SCHEMA`.
9. Submit provisional/invalid XML → 409.
10. Four-eyes schema promotion.
11. Confirmed schema becomes default and generation → `VALIDATED`.
12. Version immutability and report pinning.
13. Regenerate draft against new confirmed schema.
14. Confidential access enforcement.

XLSX:
1. Reject macros/external links/zip bomb.
2. Template named ranges fill correctly.
3. Required columns/types/totals.
4. Formula-injection guard.
5. Server-generated hash stable.
6. XLSX-only PSP-M submits with no XSD.
7. XML gate still blocks provisional XML.
8. Multi-output report generates XML + XLSX.
9. Version pinning.
10. Four-eyes template promotion.
11. Confidential access.
12. Download audit.

Lifecycle:
- DRAFT → request approval → approve → submit → acknowledge.
- Rejection/expiry returns to DRAFT.
- OD-1 provisional rule block.
- Manual payload encrypted/read.
- Due date reminders/overdue.
- `env = LIVE` filtering.
- No duplicate LTR.
- UI Playwright for studio/report drawer/rules.

## 19. Phases and PR order

1. Report lifecycle P0 fixes.
2. Schema registry + output models + migration.
3. XML compiler/generator/validator + provisional baseline.
4. XLSX renderer + provisional templates.
5. Generation wiring and admin APIs.
6. Admin Studio + report drawer + rules UI.
7. Hardening and Playwright.
8. INC later with incident management.

## 20. Verification gate

```bash
bun scripts/project-design/build.ts --check
cd core-back && bun run typecheck && bun test
cd admin-back && bun run typecheck && bun test
cd admin-front && bun run type-check && bun run test:unit && bun run build
cd tests && bun run test:unit
git diff --check
```

Database suites require PostgreSQL 18 and Redis. Report skipped suites explicitly.
