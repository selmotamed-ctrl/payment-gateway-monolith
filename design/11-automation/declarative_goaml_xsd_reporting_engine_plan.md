# Declarative XSD-Driven goAML & Regulatory Reporting Engine Plan

## Dynamic XSD Upload, AST Compilation, Declarative Field & Code-List Mapping, Versioning, Four-Eyes Governance, Automated Generation & Admin Studio (`core-back`, `admin-back`, `admin-front`)

## 1. Architectural Vision & How the Engine Works

In regulated financial ecosystems—including the Libyan Financial Information Unit (FIU) inside the Central Bank of Libya (CBL), which uses UNODC's **goAML** platform ([UNODC goAML Standard XML Reporting Specification](https://www.fedpol.admin.ch/dam/de/sd-web/CwN-464vmb9L/goaml-standard-xml-reporting.pdf))—institutions must file **Suspicious Transaction Reports (`STR` / `SUSPICIOUS_ACTIVITY`)**, **Large Transaction Reports (`LTR` / `LARGE_TRANSACTION`)**, and **Periodic Returns (`PERIODIC_RETURN`)** as XML files that pass strict validation against an **XML Schema Definition (`.xsd`)**.

### Why a Purely Hardcoded Adapter Is Not Enough—and Why an XSD Alone Is Only Half the Contract

1. **What the `.xsd` file provides (The Structural & Type Contract):** An uploaded `.xsd` file defines every allowed XML element (`<report>`, `<rentity_id>`, `<submission_code>`, `<report_code>`, `<report_date>`, `<currency_code_local>`, `<reporting_person>`, `<transaction>`, `<t_from_my_client>`, `<t_to_my_client>`, `<report_indicators>`), the mandatory `<xs:sequence>` tag order, cardinality (`minOccurs`, `maxOccurs`), data types (`xs:string`, `xs:decimal`, `xs:int`, `xs:dateTime`), facets (`minLength`, `maxLength`, `pattern`, `fractionDigits`), and allowed `xs:enumeration` code lists.

2. **What the `.xsd` file does NOT know on its own (The Domain Binding):** An `.xsd` file does not know that `<transactionnumber>` comes from our database field `attempt.reference`, that `<amount_local>` comes from `attempt.totalChargedAmount`, or that our internal rail `"mobicash"` maps to the FIU's enumeration code `"E_WALLET"` in `<funds_code>`.

3. **The Golden Solution — A Two-Layer Declarative XSD Engine:** mirrors the exact design philosophy of your **Declarative Rail Engine**:

   * **Layer 1: Uploaded `.xsd`** $\xrightarrow{\text{XsdCompiler}}$ **Normalized XSD AST (`compiledAstJson`):** When a Compliance officer uploads an `.xsd` file in `admin-front`, our pure-TypeScript **Deterministic XSD Compiler (`XsdCompiler.ts`)** validates the XSD for XXE/security safety ([OWASP XML Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/XML_Security_Cheat_Sheet.html)), resolves all `<xs:complexType>`, `<xs:simpleType>`, `<xs:sequence>`, `<xs:choice>`, and `<xs:restriction>` nodes, and compiles a deterministic **Element Tree AST** plus a catalog of all **`xs:enumeration` Code Lists**.

   * **Layer 2: Declarative Mapping Blueprint (`mappingBlueprintJson`):** Paired with the compiled XSD AST is a **Declarative Mapping Blueprint** (configurable in the `admin-front` visual XSD Studio) that binds each XSD element path (e.g., `/report/transaction/amount_local`) to:

     * A **Canonical Context Path** (e.g., `attempt.totalChargedAmount`, `merchant.legalName`, `amlCase.triggerReason`), a **Constant**, or a **Code-List Lookup Table** (`codeMap`),

     * A chain of **Transform Pipes** reusing `core-back/engine/transforms/TransformPipeline.ts` (`format_date`, `format_decimal`, `arabic_digits_to_ascii`, `phone_normalize`, `trim`, `substring`, `uppercase`),

     * A **`repeatOver` Array Path** for repeating nodes (`maxOccurs="unbounded"`, such as `/report/transaction` or `/report/report_indicators/indicator`), and

     * A **Conditional Predicate** for optional nodes or `<xs:choice>` branches (e.g., choosing `<t_from_my_client>` vs. `<t_from>` or `<from_person>` vs. `<from_entity>`).

```
+--------------------------------------------------------------------------------------------------+
|                        ADMIN FRONT — DECLARATIVE XSD STUDIO (/aml/xsd-schemas)                   |
|  1. Upload .xsd file  ──>  2. Auto-Compiled Element Tree & Enumerations                          |
|  3. Bind XML paths to Canonical Context + Transform Pipes + Code-List Lookups                    |
|  4. Live Simulator (Test against any real Attempt/Case or sample fixture -> View XML & Errors)   |
|  5. Submit for Four-Eyes Approval (PROVISIONAL -> CONFIRMED) & Set as Default for Report Type    |
+--------------------------------------------------------------------------------------------------+
                                                │
                                                ▼
+--------------------------------------------------------------------------------------------------+
|                     CORE-BACK — AUTOMATED & MANUAL REPORT GENERATION PIPELINE                    |
|  • Triggered automatically by `ReportingRuleEvaluator` (on Attempt/Case) or manually by MLRO     |
|  • Resolves pinned `ReportingRule.xsdSchemaId` OR Default Schema for `(authority, reportType)`   |
|  • Hydrates rich `CanonicalReportContext` (Attempt, Merchant, KYB, Owners, Wallet, Case, Ledger) |
|  • `XsdXmlGenerator` walks the XSD AST in strict `<xs:sequence>` order and applies transforms    |
|  • `XsdXmlValidator` validates generated XML against AST (cardinality, types, regex, enums)      |
|  • Encrypts both JSON & XML via `VaultContextCipher` (`reporting-payload` & `reporting-xml`)     |
|  • Stamps `xsdValidationStatus`: `XSD_VALIDATED` (if CONFIRMED XSD) or `PROVISIONAL_SCHEMA`      |
+--------------------------------------------------------------------------------------------------+

```

## 2. Database Schema & Migration Specification (`core-back/prisma/schema.prisma`)

### 2.1 New Enums & Models

Add the following enums and models to `core-back/prisma/schema.prisma` (and update `RegulatoryReport` and `ReportingRule`):

```
enum XsdSchemaLifecycleStatus {
  DRAFT
  PROVISIONAL
  PENDING_APPROVAL
  CONFIRMED
  SUPERSEDED
  ARCHIVED
}

enum ReportXmlValidationStatus {
  NOT_GENERATED
  PROVISIONAL_SCHEMA
  XSD_VALIDATED
  XSD_INVALID
}

/// Versioned, immutable-once-confirmed XSD schema + declarative mapping blueprint
model RegulatoryXsdSchema {
  id                   String                   @id @default(uuid(7)) @db.Uuid
  createdAt            DateTime                 @default(now()) @map("created_at")
  updatedAt            DateTime                 @updatedAt @map("updated_at")
  /// Logical family code, e.g. "cbl-goaml-str", "cbl-goaml-ltr", "cbl-periodic-return"
  schemaCode           String                   @map("schema_code") @db.Text
  name                 String                   @db.Text
  authority            String                   @default("CBL") @db.Text
  reportType           ReportingType            @map("report_type")
  version              Int                      @default(1)
  status               XsdSchemaLifecycleStatus @default(DRAFT)
  /// Raw uploaded .xsd XML text (validated for UTF-8 and XXE-free structure)
  xsdXml               String                   @map("xsd_xml") @db.Text
  xsdSha256            String                   @map("xsd_sha256") @db.Char(64)
  rootElement          String                   @map("root_element") @db.Text
  targetNamespace      String?                  @map("target_namespace") @db.Text
  /// Deterministically compiled AST (elements, sequences, choices, types, facets, enumerations)
  compiledAstJson      Json                     @map("compiled_ast_json")
  /// Declarative field bindings, transform pipes, code-list maps, and cross-field assertions
  mappingBlueprintJson Json                     @map("mapping_blueprint_json")
  /// Optional sample context JSON used in the XSD Studio simulator
  sampleContextJson    Json?                    @map("sample_context_json")
  notes                String?                  @db.Text
  createdByUserId      String?                  @map("created_by_user_id") @db.Uuid
  approvedByUserId     String?                  @map("approved_by_user_id") @db.Uuid
  approvedAt           DateTime?                @map("approved_at")
  approvalRequestId    String?                  @map("approval_request_id") @db.Uuid
  seedKey              String?                  @unique @map("seed_key")

  approvalRequest      ApprovalRequest?         @relation("RegulatoryXsdSchemaApproval", fields: [approvalRequestId], references: [id], onDelete: SetNull)
  defaultBindings      RegulatoryXsdDefaultBinding[]
  reportingRules       ReportingRule[]          @relation("ReportingRuleXsdSchema")
  reports              RegulatoryReport[]       @relation("RegulatoryReportXsdSchema")

  @@unique([authority, schemaCode, version])
  @@index([authority, reportType, status])
  @@index([schemaCode, version])
  @@map("regulatory_xsd_schemas")
}

/// Designates which XSD schema version is the active default for automated generation per (authority, reportType)
model RegulatoryXsdDefaultBinding {
  id                String              @id @default(uuid(7)) @db.Uuid
  createdAt         DateTime            @default(now()) @map("created_at")
  updatedAt         DateTime            @updatedAt @map("updated_at")
  authority         String              @db.Text
  reportType        ReportingType       @map("report_type")
  xsdSchemaId       String              @map("xsd_schema_id") @db.Uuid
  updatedByUserId   String?             @map("updated_by_user_id") @db.Uuid
  approvalRequestId String?             @map("approval_request_id") @db.Uuid

  xsdSchema         RegulatoryXsdSchema @relation(fields: [xsdSchemaId], references: [id], onDelete: Restrict)

  @@unique([authority, reportType])
  @@map("regulatory_xsd_default_bindings")
}

```

### 2.2 Additions to `ReportingRule` and `RegulatoryReport`

1. **On `ReportingRule`:**

   * Add optional `xsdSchemaId String? @map("xsd_schema_id") @db.Uuid` with relation `xsdSchema RegulatoryXsdSchema? @relation("ReportingRuleXsdSchema", fields: [xsdSchemaId], references: [id], onDelete: SetNull)`.

   * *Behavior:* When a rule specifies `xsdSchemaId`, automated generation uses that schema; when `xsdSchemaId` is `null`, automated generation uses the active `RegulatoryXsdDefaultBinding` for `(rule.authority, rule.reportType)`.

2. **On `RegulatoryReport`:**

   * Add:

     * `xsdSchemaId String? @map("xsd_schema_id") @db.Uuid`

     * `xsdSchemaVersion Int? @map("xsd_schema_version")`

     * `xmlCiphertext String? @map("xml_ciphertext") @db.Text` (encrypted via `VaultContextCipher(vault, "reporting-xml")`)

     * `xmlSha256 String? @map("xml_sha256") @db.Char(64)`

     * `xsdValidationStatus ReportXmlValidationStatus @default(NOT_GENERATED) @map("xsd_validation_status")`

     * `xsdValidationErrorsJson Json? @map("xsd_validation_errors_json")`

     * `xsdSchema RegulatoryXsdSchema? @relation("RegulatoryReportXsdSchema", fields: [xsdSchemaId], references: [id], onDelete: Restrict)`

## 3. Core Engine Architecture (`core-back/engine/compliance/goaml/`)

Create a dedicated, pure-TypeScript module tree under `core-back/engine/compliance/goaml/` with zero external C++ bindings:

```
core-back/engine/compliance/goaml/
├── types.ts                  # AST, Mapping Blueprint, Canonical Context & Validation types
├── XsdCompiler.ts            # Safe XML/XSD tokenizer + compiler -> XsdCompiledAst
├── XsdXmlGenerator.ts        # Walks XsdCompiledAst + MappingBlueprint + Context -> XML string
├── XsdXmlValidator.ts        # Validates generated XML against XsdCompiledAst + Assertions
├── CanonicalReportContext.ts # Hydrates full Merchant/KYB/Owner/Wallet/Attempt/Case/Ledger data
├── seedBaselineGoamlXsd.ts   # Built-in goaml-cbl-str-v1 & goaml-cbl-ltr-v1 provisional schemas
└── GoamlReportingService.ts  # Orchestrates compilation, preview, auto-generation & re-generation

```

### 3.1 Security First: Safe XSD & XML Parsing (`XsdCompiler.ts`)

Per the [OWASP XML Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/XML_Security_Cheat_Sheet.html), an uploaded `.xsd` file must never be passed to a parser that resolves external entities or network URLs:

1. **Hard Rejections Before Parsing:**

   * Reject any `.xsd` payload larger than `2 MB` (`413 XSD_PAYLOAD_TOO_LARGE`).

   * Reject any `.xsd` containing `<!DOCTYPE`, `<!ENTITY`, `SYSTEM`, `PUBLIC`, `<xs:import`, `<xs:include`, or `<xs:redefine` with external `schemaLocation` URLs (`422 XSD_EXTERNAL_ENTITY_FORBIDDEN`).

   * Enforce a maximum AST nesting depth of `32` and a maximum `maxOccurs` loop bound of `5,000` items during generation to prevent "Billion Laughs" or unbounded memory exhaustion.

### 3.2 Compiled XSD AST Contract (`types.ts`)

`XsdCompiler.compile(xsdXml: string): XsdCompiledAst` parses `<xs:schema>` into a self-contained JSON AST stored in `compiledAstJson`:

```
export type XsdPrimitiveType =
  | "xs:string"
  | "xs:token"
  | "xs:normalizedString"
  | "xs:int"
  | "xs:integer"
  | "xs:long"
  | "xs:positiveInteger"
  | "xs:nonNegativeInteger"
  | "xs:decimal"
  | "xs:boolean"
  | "xs:date"
  | "xs:dateTime";

export interface XsdTypeFacets {
  baseType: XsdPrimitiveType;
  minLength?: number;
  maxLength?: number;
  length?: number;
  pattern?: string;
  enumeration?: string[];
  minInclusive?: string;
  maxInclusive?: string;
  totalDigits?: number;
  fractionDigits?: number;
}

export interface XsdAttributeNode {
  name: string;
  use: "required" | "optional" | "prohibited";
  defaultValue?: string;
  fixedValue?: string;
  facets: XsdTypeFacets;
}

export interface XsdElementNode {
  /** Element tag name, e.g. "report", "rentity_id", "transaction" */
  name: string;
  /** Canonical slash path, e.g. "/report/transaction/amount_local" */
  path: string;
  /** Position inside parent <xs:sequence> (0-indexed) */
  sequenceOrder: number;
  minOccurs: number;
  maxOccurs: number | "unbounded";
  nillable?: boolean;
  documentation?: string;
  kind: "simple" | "complex";
  compositor?: "sequence" | "choice" | "all";
  facets?: XsdTypeFacets;
  attributes: XsdAttributeNode[];
  children: XsdElementNode[];
}

export interface XsdCompiledAst {
  targetNamespace: string | null;
  elementFormDefault: "qualified" | "unqualified";
  rootElement: XsdElementNode;
  /** Flattened index of all element paths for O(1) UI & validator lookup */
  paths: Record<string, {
    path: string;
    kind: "simple" | "complex";
    minOccurs: number;
    maxOccurs: number | "unbounded";
    facets?: XsdTypeFacets;
    documentation?: string;
  }>;
  /** Named and inline enumeration code lists extracted from the XSD */
  codeLists: Record<string, {
    name: string;
    usedByPaths: string[];
    allowedValues: string[];
  }>;
}

```

### 3.3 Declarative Mapping Blueprint Contract (`mappingBlueprintJson`)

The Mapping Blueprint connects the compiled XSD paths to our platform's domain data without writing TypeScript code:

```
export interface ElementFieldBinding {
  /** Target XSD path, e.g. "/report/transaction/amount_local" */
  xsdPath: string;
  /** How the value is resolved */
  sourceKind: "CONTEXT_PATH" | "CONSTANT" | "CODE_MAP" | "TEMPLATE";
  /** Dot-path into CanonicalReportContext (or item scope inside repeatOver), e.g. "attempt.totalChargedAmount" */
  contextPath?: string;
  /** Static fallback or constant value, e.g. "LYD" or "E" */
  constantValue?: string;
  /** Lookup map key in blueprint.codeMaps, e.g. "rail_to_funds_code" */
  codeMapKey?: string;
  /** TransformPipeline pipes applied in order (e.g. [{ op: "format_decimal", args: [4] }, { op: "trim" }]) */
  transforms?: TransformPipe[];
  /** Optional condition: element is emitted only when predicate matches */
  condition?: {
    contextPath: string;
    operator: "EQ" | "NEQ" | "IN" | "NOT_EMPTY" | "GT";
    value?: unknown;
  };
}

export interface RepeatingNodeBinding {
  /** Complex element path with maxOccurs > 1, e.g. "/report/transaction" */
  xsdPath: string;
  /** Array path in CanonicalReportContext, e.g. "transactions" or "indicators" */
  repeatOverContextPath: string;
  /** Variable prefix used inside child bindings, e.g. "tx" -> "tx.reference" */
  itemAlias: string;
}

export interface CrossFieldAssertion {
  id: string;
  description: string;
  /** When condition holds, target xsdPath must be present/non-empty */
  when: { xsdPath: string; operator: "EQ" | "IN"; value: string | string[] };
  requirePaths: string[];
}

export interface GoamlMappingBlueprint {
  schemaVersion: 1;
  repeatingNodes: RepeatingNodeBinding[];
  fieldBindings: ElementFieldBinding[];
  /** Translates internal platform enums/codes to XSD xs:enumeration values */
  codeMaps: Record<string, {
    description: string;
    mappings: Record<string, string>;
    defaultFallback?: string;
  }>;
  assertions: CrossFieldAssertion[];
}

```

### 3.4 Rich Canonical Report Context (`CanonicalReportContext.ts`)

Right now, `ReportingRuleEvaluator.ts` (lines 179–193) only writes a tiny 11-field JSON object (`{ ruleId, attemptId, merchantId, amount, currency }`). For goAML `STR`, `LTR`, and `PERIODIC_RETURN` reports, `CanonicalReportContextBuilder` hydrates a complete, structured snapshot at generation time (and encrypts it in `payloadCiphertext`):

* **`institution`:** Platform settings (`rentityId`, `rentityBranch`, `submissionCode: "E"`, `localCurrencyCode: "LYD"`, reporting officer identity from MLRO/system config).

* **`report`:** `id`, `reportRef`, `reportType`, `goamlReportCode` (`STR` / `LTR` / `AIF`), `authority`, `generatedAt`, `periodStart`, `periodEnd`, `reason`, `actionTaken`.

* **`merchant`:** `id`, `legalName`, `tradeName`, `registrationNo`, `taxId`, `businessCategory`, `country`, `contactPhone`, `contactEmail`, `status`, `kybStatus`, `riskTier`, `payoutBankDetails`, and `beneficialOwners[]` (with decrypted national IDs only inside `core-back`'s confidential report builder).

* **`wallet` & `glAccount`:** Merchant wallet ID, currency, and current sharded balance.

* **`transactions[]`:** For a single-attempt `STR`/`LTR`, the triggering `PaymentAttempt` (or for a window/periodic rule, all matching attempts in `[periodStart, periodEnd]`):

  * `id`, `reference`, `providerReference`, `gatewayReference`, `networkReference`, `createdAt`, `settledAt`, `status`, `amount`, `surchargeAmount`, `totalChargedAmount`, `settledAmount`, `currency`, `railCode`, `gatewayCode`, `collectionMode`, `confirmationChannel`, `payerPhone`, `payerName`, `payerIp`, `payerAccountRef`.

* **`amlCase` & `indicators[]`:** Linked `AmlCase` (`id`, `triggerReason`, `severity`, `status`, `resolutionNotes`), triggered `AmlRule` codes, and any `AmlScreening` match details.

### 3.5 Built-In Baseline Schema (`seedBaselineGoamlXsd.ts`)

So the system works out of the box on day one—even before the compliance officer uploads the CBL FIU's `.xsd` file—`db-seed` seeds three `PROVISIONAL` schemas (with real, valid W3C `.xsd` documents modeled on UNODC goAML 5.0 and complete `mappingBlueprintJson` bindings):

1. `cbl-goaml-ltr-v1` (`authority: "CBL"`, `reportType: "LARGE_TRANSACTION"`, `status: "PROVISIONAL"`)

2. `cbl-goaml-str-v1` (`authority: "CBL"`, `reportType: "SUSPICIOUS_ACTIVITY"`, `status: "PROVISIONAL"`)

3. `cbl-goaml-return-v1` (`authority: "CBL"`, `reportType: "PERIODIC_RETURN"`, `status: "PROVISIONAL"`)

And sets them as the initial `RegulatoryXsdDefaultBinding` rows for `CBL`. Any report generated from a `PROVISIONAL` schema is stamped `xsdValidationStatus = "PROVISIONAL_SCHEMA"` and displays the mandatory compliance safeguard banner until a `CONFIRMED` FIU XSD schema is uploaded and approved.

## 4. Governance, Authorization & Automated Generation Rules

### 4.1 Strict Authorization Matrix

| Action | Endpoint | Required Authority / Role | Four-Eyes Maker-Checker Required? | 
| ----- | ----- | ----- | ----- | 
| List / View XSD schemas, AST, and mappings | `GET /aml/xsd-schemas`  `GET /aml/xsd-schemas/:id`  `GET /aml/xsd-defaults` | `assertConfidential` (`MLRO`, `COMPLIANCE`, or `aml:read` / `compliance:read` / `report:review`) | No (Read-only confidential) | 
| Upload new `.xsd` or save `DRAFT` / `PROVISIONAL` mapping version | `POST /aml/xsd-schemas`  `PUT /aml/xsd-schemas/:id` | `assertReportingAuthority` (`MLRO`, `COMPLIANCE`, or `report:approve` / `compliance:write` / `aml:write`) | No (Creates/edits `DRAFT` or `PROVISIONAL` version; audited as `REGULATORY_XSD_SCHEMA_SAVED`) | 
| Test / Simulate XSD + Mapping against a real Attempt/Case or sample JSON | `POST /aml/xsd-schemas/:id/simulate` | `assertConfidential` | No (Read-only dry run returning generated XML + line-by-line XSD validation report) | 
| Promote XSD Schema to `CONFIRMED` (and optionally bind as Default for `authority + reportType`) | `POST /aml/xsd-schemas/:id/promote` | `assertReportingAuthority` | **YES (`subjectType: "REGULATORY_XSD_SCHEMA"`).** Maker proposes; a *different* checker with `approval:check` + confidential AML access approves. | 
| Switch Default XSD Schema for `(authority, reportType)` | `PUT /aml/xsd-defaults` | `assertReportingAuthority` | **YES** when binding a `CONFIRMED` schema for live filing; audited as `REGULATORY_XSD_DEFAULT_UPDATED`. | 
| Generate / Re-generate XML for a `RegulatoryReport` & Download XML | `POST /aml/reports/:id/generate-xml`  `GET /aml/reports/:id/xml` | `assertReportingAuthority` | Audited as `REGULATORY_REPORT_XML_GENERATED` and `REGULATORY_REPORT_XML_DOWNLOADED`. | 
| Submit `RegulatoryReport` to Authority (`SUBMITTED`) | `POST /aml/reports/:id/submit` | `assertReportingAuthority` (Checker != Maker) | **Hard Gate:** Refuses with `409 REPORT_XML_NOT_XSD_VALIDATED` if `xsdValidationStatus !== "XSD_VALIDATED"` or if the XSD schema is still `PROVISIONAL`! | 

### 4.2 Automated Report Generation (`ReportingRuleEvaluator.ts`)

When `ReportingRuleEvaluator.evaluate(attempt)` fires on a payment attempt:

1. It resolves the target XSD schema in order:

   * `rule.xsdSchemaId` (if the `ReportingRule` pinned a specific XSD schema),

   * Otherwise, the active `RegulatoryXsdDefaultBinding` for `(rule.authority, rule.reportType)`.

2. It builds the `CanonicalReportContext` for `(attempt, rule)`.

3. It runs `GoamlReportingService.generateAndValidate(schema, context)`:

   * Generates the deterministic XML string via `XsdXmlGenerator`.

   * Validates the XML against `schema.compiledAstJson` and `schema.mappingBlueprintJson.assertions` via `XsdXmlValidator`.

   * Computes `xmlSha256 = sha256(xmlString)` and encrypts `xmlCiphertext = await reportingXmlCipher.encrypt(xmlString)`.

   * Sets `xsdValidationStatus`:

     * `"XSD_VALIDATED"` if validation passed with 0 errors AND `schema.status === "CONFIRMED"`.

     * `"PROVISIONAL_SCHEMA"` if validation passed with 0 errors AND `schema.status === "PROVISIONAL"`.

     * `"XSD_INVALID"` if any XSD constraint failed (and records the exact element path and facet violation in `xsdValidationErrorsJson` so compliance officers see what merchant/KYC field is missing!).

## 5. Front-Admin Interface Design (`admin-front`)

### 5.1 Navigation & Route Integration

In `admin-front/src/pages/aml/reports/index.tsx` and `admin-front/src/pages/aml/rules/index.tsx`:

* Add a top-level segmented tab / route **`XSD Schemas & goAML Studio`** (`/aml/xsd-schemas`, route name `AmlXsdSchemas`, gated by `aml:read` / `compliance:read` / `report:review`).

* Enhance the **`AML Reports` SlideOverDrawer** (`admin-front/src/pages/aml/reports/index.tsx`) with a dedicated **`goAML XML & XSD Validation`** section.

### 5.2 Screen 1: `XSD Schemas & Default Bindings` (`/aml/xsd-schemas`)

1. **Default Active Schemas Strip (Top Cards per Report Type):**

   * Shows the 3 report types (`LARGE_TRANSACTION`, `SUSPICIOUS_ACTIVITY`, `PERIODIC_RETURN`) for `CBL` (and any other configured authority).

   * Displays the currently bound default schema name, version badge (`v1`, `v2`), status badge (`PROVISIONAL` in amber warning vs. `CONFIRMED` in green success), SHA-256 fingerprint, and a **"Change Default Schema"** button.

2. **Upload & Version Registry Table:**

   * Lists all `RegulatoryXsdSchema` versions grouped by `schemaCode`, showing `name`, `authority`, `reportType`, `version`, `status`, `rootElement`, element count, code-list count, `xsdSha256`, and actions:

     * **Open Studio / Mapper**

     * **Clone as New Version (`v+1`)**

     * **Promote to Confirmed (Four-Eyes)**

     * **Set as Default for Report Type**

### 5.3 Screen 2: `Declarative XSD Studio & Visual Mapper` (Drawer / Full-Screen Modal)

Contains four clean tabs:

1. **Tab 1 — XSD Source & AST Inspector:**

   * Upload `.xsd` file (or paste XSD XML) $\to$ click **Compile & Inspect XSD**.

   * Shows the parsed **XSD Element Tree** in exact `<xs:sequence>` order with badges for `REQUIRED` (`minOccurs >= 1`), `REPEATING` (`maxOccurs="unbounded"`), data type (`xs:decimal`, `xs:dateTime`), and restrictions (`maxLength="34"`, `pattern`, `enumeration`).

2. **Tab 2 — Declarative Field Mapper:**

   * For every leaf element in the compiled XSD AST, renders a structured row:

     * **Left:** XSD Path (`/report/rentity_id`, `/report/transaction/amount_local`) + XSD Type & Constraints.

     * **Middle:** Source Selector (`Context Path` dropdown of all `CanonicalReportContext` fields, `Constant Value`, or `Code-List Map`).

     * **Right:** Transform Pipe Builder (reusing `TransformPipeline` ops: `format_date`, `format_decimal`, `arabic_digits_to_ascii`, `phone_normalize`, `trim`, `substring`).

3. **Tab 3 — Code-List & Enumeration Translators:**

   * Automatically lists every `xs:enumeration` discovered in the `.xsd` (e.g., `report_code`, `funds_code`, `account_type`, `indicator_code`) and lets the compliance officer map internal platform values (e.g., `mobicash`, `sadad`, `local_card`) to the exact allowed XSD enumeration codes!

4. **Tab 4 — Live Dry-Run Simulator & Validator:**

   * Select any real `PaymentAttempt` ID / `AmlCase` ID (or use the editable sample context) and click **Simulate XML Generation**.

   * Displays the generated XML side-by-side with the **XSD Validation Verdict**:

     * Green badge (`0 XSD Errors — Valid against Schema vN`) or

     * Detailed error list pinpointing the exact XML path, violated XSD facet (`minOccurs`, `pattern`, `enumeration`), and actual value.

### 5.4 Screen 3: Enhancements to `AML Reports` Detail Drawer (`admin-front/src/pages/aml/reports/index.tsx`)

Inside the `SlideOverDrawer` for any `RegulatoryReport`:

1. **Validation & Schema Status Banner:**

   * When `xsdValidationStatus === "PROVISIONAL_SCHEMA"`, displays a prominent warning `VAlert`:

     > **"Provisional output — generated with `cbl-goaml-str-v1 (PROVISIONAL)` and not validated against a confirmed FIU XSD. Do not upload to the CBL goAML portal until Compliance confirms the official FIU XSD."**

   * When `xsdValidationStatus === "XSD_VALIDATED"`, displays a green `VAlert`:

     > **"Verified against Confirmed XSD (`vN`, SHA-256 `...`) — Ready for regulatory filing."**

   * When `xsdValidationStatus === "XSD_INVALID"`, lists each missing/invalid element path and offers a **"Re-validate / Re-generate with Active Default XSD"** button.

2. **XML Preview & Audited Download Action:**

   * **"Preview goAML XML"** (renders syntax-highlighted, read-only XML inside the drawer for authorized `MLRO`/`COMPLIANCE` staff).

   * **"Download `.xml` File"** (downloads `STR-RPT-XXXX.xml` and writes an audit trail entry).

   * **Submission Gate:** The **"Submit report"** button is enabled **only** when `report.status === "APPROVED"` **AND** `report.xsdValidationStatus === "XSD_VALIDATED"`.

## 6. Drop-In Core Implementation Code for Coding Agents

### 6.1 Pure-TypeScript XSD Compiler & Validator (`XsdCompiler.ts` & `XsdXmlValidator.ts`)

Below is the core implementation pattern for `core-back/engine/compliance/goaml/XsdCompiler.ts` and `XsdXmlValidator.ts` that compiles any standard W3C `.xsd` (including UNODC goAML 4.x and 5.x schemas) without external native dependencies:

```
// File: core-back/engine/compliance/goaml/XsdCompiler.ts
import { createHash } from "node:crypto";
import { ApiError } from "../../../lib/error";
import type {
  XsdAttributeNode,
  XsdCompiledAst,
  XsdElementNode,
  XsdPrimitiveType,
  XsdTypeFacets,
} from "./types";

const MAX_XSD_BYTES = 2 * 1024 * 1024; // 2 MB

const FORBIDDEN_XXE_PATTERNS = [
  /<!DOCTYPE/i,
  /<!ENTITY/i,
  /\bSYSTEM\s+["']/i,
  /\bPUBLIC\s+["']/i,
  /<(?:xs|xsd):(?:import|include|redefine)\b[^>]*\bschemaLocation\s*=\s*["']https?:/i,
];

export const assertSafeXsdXml = (rawXml: string): void => {
  if (Buffer.byteLength(rawXml, "utf8") > MAX_XSD_BYTES) {
    throw new ApiError(413, "XSD_PAYLOAD_TOO_LARGE", "The XSD file exceeds the 2 MB limit");
  }
  for (const pattern of FORBIDDEN_XXE_PATTERNS) {
    if (pattern.test(rawXml)) {
      throw new ApiError(
        422,
        "XSD_EXTERNAL_ENTITY_FORBIDDEN",
        "DOCTYPE, ENTITY declarations, and remote schemaLocation imports are forbidden for security",
      );
    }
  }
};

export const sha256Hex = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

```

### 6.2 Deterministic AST-Walking XML Generator (`XsdXmlGenerator.ts`)

Because `XsdXmlGenerator` walks `ast.rootElement.children` in their compiled `sequenceOrder`, every child tag is emitted in the exact `<xs:sequence>` order required by the `.xsd`:

```
// File: core-back/engine/compliance/goaml/XsdXmlGenerator.ts
import { TransformPipeline } from "../../transforms/TransformPipeline";
import type {
  CanonicalReportContext,
  ElementFieldBinding,
  GoamlMappingBlueprint,
  XsdCompiledAst,
  XsdElementNode,
} from "./types";

export const escapeXmlText = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

export class XsdXmlGenerator {
  private readonly pipeline = new TransformPipeline();

  generate(
    ast: XsdCompiledAst,
    blueprint: GoamlMappingBlueprint,
    context: CanonicalReportContext,
  ): string {
    const fieldByPath = new Map<string, ElementFieldBinding>(
      blueprint.fieldBindings.map((b) => [b.xsdPath, b]),
    );
    const repeatByPath = new Map(
      blueprint.repeatingNodes.map((r) => [r.xsdPath, r]),
    );

    const renderNode = (
      node: XsdElementNode,
      scope: Record<string, unknown>,
      indent: string,
    ): string[] => {
      const repeat = repeatByPath.get(node.path);
      if (repeat) {
        const list = this.resolvePath(scope, repeat.repeatOverContextPath);
        const items = Array.isArray(list) ? list.slice(0, 5000) : [];
        return items.flatMap((item) =>
          renderSingleNode(node, { ...scope, [repeat.itemAlias]: item }, indent),
        );
      }
      return renderSingleNode(node, scope, indent);
    };

    const renderSingleNode = (
      node: XsdElementNode,
      scope: Record<string, unknown>,
      indent: string,
    ): string[] => {
      const binding = fieldByPath.get(node.path);
      if (binding?.condition && !this.evaluateCondition(binding.condition, scope)) {
        return [];
      }

      if (node.kind === "simple" || node.children.length === 0) {
        const rawValue = this.resolveBindingValue(binding, blueprint, scope);
        if (rawValue === null || rawValue === undefined || rawValue === "") {
          if (node.minOccurs === 0) return [];
          return [`${indent}<${node.name}></${node.name}>`];
        }
        return [`${indent}<${node.name}>${escapeXmlText(String(rawValue))}</${node.name}>`];
      }

      const orderedChildren = [...node.children].sort(
        (a, b) => a.sequenceOrder - b.sequenceOrder,
      );
      const childLines = orderedChildren.flatMap((child) =>
        renderNode(child, scope, `${indent}  `),
      );
      if (childLines.length === 0 && node.minOccurs === 0) {
        return [];
      }
      return [
        `${indent}<${node.name}>`,
        ...childLines,
        `${indent}</${node.name}>`,
      ];
    };

    const bodyLines = renderNode(ast.rootElement, context as unknown as Record<string, unknown>, "");
    return [`<?xml version="1.0" encoding="UTF-8"?>`, ...bodyLines].join("\n");
  }
  // ... helper methods resolvePath, resolveBindingValue, evaluateCondition
}

```

### 6.3 Governance Execution Handler (`core-back/engine/governance/GovernanceExecution.ts`)

Register `REGULATORY_XSD_SCHEMA` inside `executeApprovalSubject` in `core-back/engine/governance/GovernanceExecution.ts` so four-eyes approval promotes the schema from `PENDING_APPROVAL` to `CONFIRMED`, marks previous `CONFIRMED` versions of the same `(authority, schemaCode)` as `SUPERSEDED`, and optionally updates `RegulatoryXsdDefaultBinding` in one atomic transaction:

```
const executeRegulatoryXsdSchemaApproval = async (
  ctx: GovernanceExecutionContext,
  tx: Tx,
  input: ExecuteApprovalInput,
): Promise<GovernanceExecutionResult> => {
  const schemas = modelOf(tx, "regulatoryXsdSchema");
  const defaults = modelOf(tx, "regulatoryXsdDefaultBinding");
  const schema = await schemas.findUnique({ where: { id: input.approval.subjectId } });
  if (!schema) {
    throw new ApiError(404, "XSD_SCHEMA_NOT_FOUND", "The regulatory XSD schema does not exist");
  }
  const payload = asRecord(input.approval.payloadDiffJson);
  const setAsDefault = payload?.setAsDefault !== false;

  // Mark prior CONFIRMED versions of the same (authority, schemaCode) as SUPERSEDED
  await schemas.updateMany({
    where: {
      authority: schema.authority,
      schemaCode: schema.schemaCode,
      status: "CONFIRMED",
      id: { not: schema.id },
    },
    data: { status: "SUPERSEDED" },
  });

  const updated = await schemas.update({
    where: { id: schema.id },
    data: {
      status: "CONFIRMED",
      approvedByUserId: input.checkerUserId,
      approvedAt: ctx.clock(),
    },
  });

  if (setAsDefault) {
    await defaults.upsert({
      where: {
        authority_reportType: {
          authority: schema.authority,
          reportType: schema.reportType,
        },
      },
      create: {
        authority: schema.authority,
        reportType: schema.reportType,
        xsdSchemaId: schema.id,
        updatedByUserId: input.checkerUserId,
        approvalRequestId: input.approval.id,
      },
      update: {
        xsdSchemaId: schema.id,
        updatedByUserId: input.checkerUserId,
        approvalRequestId: input.approval.id,
      },
    });
  }

  return {
    subjectType: "REGULATORY_XSD_SCHEMA",
    subjectId: String(updated.id),
    status: "EXECUTED",
  };
};

```

## 7. Exhaustive Test Matrix & Edge Cases (`core-back/test/goaml-xsd-engine.test.ts`)

To guarantee security, XML validity, and governance compliance, implement the following **14 automated test scenarios** in `core-back/test/goaml-xsd-engine.test.ts`:

| Test ID | Scenario | Expected Outcome | 
| ----- | ----- | ----- | 
| **XSD-01** | Upload `.xsd` containing `<!DOCTYPE` or external `http://` `schemaLocation` | Rejected immediately with `422 XSD_EXTERNAL_ENTITY_FORBIDDEN`. | 
| **XSD-02** | Compile UNODC goAML 5.0 STR & LTR `.xsd` schemas | Extracts exact `<xs:sequence>` order, `minOccurs`/`maxOccurs`, regex patterns, `fractionDigits`, and `xs:enumeration` code lists (`report_code`, `funds_code`, `indicator`). | 
| **XSD-03** | Out-of-order mapping bindings in `mappingBlueprintJson` | `XsdXmlGenerator` still emits XML elements in the **exact `<xs:sequence>` order** defined by the XSD AST, never the order of the mapping array. | 
| **XSD-04** | XML special-character escaping (`&`, `<`, `>`, `"`, `'`) in merchant name or AML notes | Escaped cleanly (`Noon &amp; Co &lt;Tripoli&gt;`); generated XML parses with zero syntax errors. | 
| **XSD-05** | Code-list translation (`railCode: "mobicash"` $\to$ `<funds_code>E_WALLET</funds_code>`) | Translates via `codeMaps` and passes `xs:enumeration` validation; unmapped value without fallback triggers `XSD_ENUMERATION_VIOLATION` naming the exact XSD path. | 
| **XSD-06** | Missing mandatory element (`minOccurs="1"`, e.g. missing `rentity_id` or `transactionnumber`) | `XsdXmlValidator` marks report `XSD_INVALID` and records `{ path: "/report/rentity_id", rule: "minOccurs", message: "Required element is missing or empty" }`. | 
| **XSD-07** | Cross-field assertion (`report_code == "STR"` requires `<reason>` and $\ge 1$ `<indicator>`) | Validated by `XsdXmlValidator`; missing indicator flags `XSD_ASSERTION_FAILED`. | 
| **XSD-08** | Automated generation via `ReportingRuleEvaluator` with default `PROVISIONAL` schema | Creates `RegulatoryReport` with encrypted `xmlCiphertext`, `xmlSha256`, and `xsdValidationStatus = "PROVISIONAL_SCHEMA"`. | 
| **XSD-09** | Attempt to submit (`POST /aml/reports/:id/submit`) a report with `PROVISIONAL_SCHEMA` or `XSD_INVALID` | Refused with `409 REPORT_XML_NOT_XSD_VALIDATED`—preventing accidental upload of provisional or invalid XML to the FIU. | 
| **XSD-10** | Four-Eyes Maker-Checker promotion of XSD schema (`DRAFT` $\to$ `PENDING_APPROVAL` $\to$ `CONFIRMED`) | Same user attempting to approve their own XSD promotion is rejected (`403 MAKER_CANNOT_BE_CHECKER`); second MLRO approves, promoting schema to `CONFIRMED` and updating `RegulatoryXsdDefaultBinding`. | 
| **XSD-11** | Automated generation after `CONFIRMED` XSD schema becomes default | `ReportingRuleEvaluator` automatically uses the new `CONFIRMED` schema and stamps `xsdValidationStatus = "XSD_VALIDATED"`. | 
| **XSD-12** | Version immutability & historical report pinning | Uploading `v2` of `cbl-goaml-str` marks `v1` as `SUPERSEDED`; existing reports generated under `v1` remain pinned to `v1`'s `xsdSchemaId` and `compiledAstJson`. | 
| **XSD-13** | Re-generating an existing draft report against a newly promoted `CONFIRMED` XSD (`POST /aml/reports/:id/generate-xml`) | Upgrades the draft report's XML to the `CONFIRMED` schema, re-validates, updates `xmlSha256`, and audits `REGULATORY_REPORT_XML_GENERATED`. | 
| **XSD-14** | Confidential access enforcement (`AML_CONFIDENTIAL_ROLE_REQUIRED`) | Non-compliance operators (`SUPPORT`, `FINANCE`, `OPS`) receive `403` on all `/aml/xsd-schemas` and `/aml/reports/:id/xml` endpoints. | 
