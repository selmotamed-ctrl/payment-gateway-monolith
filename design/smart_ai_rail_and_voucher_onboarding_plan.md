# Smart AI-Assisted Provider & Rail Onboarding — Architectural & Delivery Plan

**Subtitle:** Offline "Bring-Your-Own-AI" (BYO-AI) Prompt Pack & Declarative Spec Importer for both the **Multi-Rail Payment Gateway** (`payment-gateway-monolith`) and the **Voucher Provider Management System**.

## 1. Executive Concept & Why This Approach Works So Well

Manually filling out an 8-step wizard (or building a multi-query voucher stack) from a messy 30-page PDF or Postman collection takes hours and is prone to human typos in dot-path selectors, transform pipelines, or HMAC signing recipes.

At the same time, plugging an external LLM API directly into your backend (`core-back`) would violate your **air-gapped / local-LAN security boundary** (`admin-back` and `core-back` have no need to talk to OpenAI/Anthropic servers) and would risk sending live provider credentials to third-party AI cloud services.

Your proposed **"Download AI Transcript -> External AI Generates Spec JSON -> Upload, Verify & Auto-Integrate"** workflow solves both problems cleanly:

1. **Zero Backend AI Dependency & Air-Gap Safe:** Your servers never call an external AI API. The admin uses any frontier AI model they prefer (Claude, ChatGPT, Gemini, OpenCode) in their own browser or local environment.
2. **Always In Sync with Your Engine:** Because the "AI Onboarding Transcript" (`AI-Integration-Guide.md`) is generated dynamically by your backend, it always reflects your exact current Zod schema, transform whitelist, and parameter types.
3. **One Pattern for Both Platforms:** The exact same 4-stage architecture works for **Payment Gateway Rails** and **Voucher Providers**—only the domain schema inside the transcript changes.

## 2. Three Critical Refinements to Make It Bulletproof

Before implementing this across both systems, incorporate these three refinements so you never leak secrets or import broken logic:

### Refinement A: Credential Shape vs. Actual Secret Values (Zero-Secret AI Prompting)
- **The Trap:** If an admin pastes actual live API keys or HMAC secrets into an external AI chat alongside the documentation, those live secrets are now sitting in a third-party AI provider's training logs.
- **The Fix:** The downloadable AI Transcript must instruct the admin to give the AI **only the credential *names/types* (or dummy sandbox values)**, never live secrets. The generated Spec JSON declares a **`required_credentials` manifest** (e.g., `[{ key: "MID", is_secret: false }, { key: "MerchantSecretKey", is_secret: true, encoding: "HEX" }]`). When the admin uploads the Spec JSON into the portal, the UI automatically renders secure password inputs for those declared keys so the admin enters the real secrets directly into your system.

### Refinement B: Embedded "Self-Test Vectors" Inside the Spec JSON
- **The Trap:** An AI might hallucinate a JSON selector (`data.result.tx_id` instead of `result.transaction_id`) or pick the wrong amount scale (`100` instead of `1000`).
- **The Fix:** Require the AI to extract **2–3 sample request/response payloads** directly from the provider's documentation and include them inside a `test_vectors` block in the generated Spec JSON. When the Spec JSON is uploaded, your backend immediately runs its **Dry-Run & Extraction Simulator** against those embedded vectors *before* even making a live network call. If the AI's selectors fail to extract the expected fields from the doc's own sample response, the upload screen immediately tells the admin what failed (and gives them a 1-click error snippet to paste back to the AI to fix).

### Refinement C: Always Import into `DRAFT` / `BLOCKED` State First
- **The Fix:** Uploading a valid Spec JSON automatically populates all database tables in a single transaction, but sets the Gateway Version to **`DRAFT`** (in the Payment Gateway) or the Provider to **`blocked = true`** (in the Voucher System). The admin then enters the real credentials, clicks **"Run Live Check / Dry-Run"**, and promotes it to active/live (via Maker-Checker in the Payment Gateway).

## 3. End-to-End 4-Stage User & System Workflow

| Stage | Actor | What Happens in Both Systems |
| :--- | :--- | :--- |
| **Stage 1: Download the AI Onboarding Kit** | Admin in Portal (`admin-front`) | Admin clicks **"Smart AI Integration -> Download AI Onboarding Transcript"**. The backend generates a single self-contained Markdown file (`rail-integration-kit.md` or `voucher-provider-kit.md`) containing:<br>1. System role instructions for the AI,<br>2. The exact JSON Schema the AI must output,<br>3. The closed list of allowed Auth Methods, Parameter Sources, and Transform/Crypto operations,<br>4. Two complete "Gold Standard" examples (e.g., an OTP rail + a Redirect rail, or a Fixed + API voucher provider),<br>5. A fill-in-the-blank section at the bottom where the admin pastes the provider's API docs and credential field names. |
| **Stage 2: AI Spec Generation** | Admin + External AI | Admin gives the downloaded transcript + the provider's documentation (PDF/Markdown/Postman/cURL) + credential structure to the AI. The AI outputs a single, strictly structured **`integration-spec.json`** file (including `test_vectors` extracted from the docs). |
| **Stage 3: Upload & 4-Layer Verification** | Admin in Portal -> Backend Engine | Admin uploads `integration-spec.json` in the Admin Portal. The backend runs a **4-Layer Verification Pipeline** without writing to the database yet:<br>- **Layer 1 (Schema & Version Check):** Validates JSON against the master Zod schema and `spec_version`.<br>- **Layer 2 (Semantic & Security Guard):** Verifies URLs are `https://` (no private/loopback SSRF IPs), `PREVIOUS_REQUEST_DATA` is never used on step 1, `MOVES_MONEY` steps have `retry_policy = NEVER`, and selectors/transforms are type-safe.<br>- **Layer 3 (Offline Vector Simulation):** Runs the spec's request builders, crypto signers, and response extractors against the `test_vectors` included in the JSON and verifies the outputs match expected values.<br>- **Layer 4 (Collision Check):** Checks if the gateway/provider/rail code already exists (offering "Create New" vs. "Create New Draft Version"). |
| **Stage 4: Secret Binding, Live Probe & Activation** | Admin in Portal | Once verification passes, the UI displays a visual preview of the imported integration and prompts the admin for the actual secret values declared in `required_credentials`. Clicking **"Import & Verify"** saves the full configuration in one DB transaction (`DRAFT` / `blocked`), runs the live `CREDENTIAL_CHECK` / `api-listing/test`, and readies it for activation. |

## 4. How the Spec Adapts Between Your Two Systems

The architecture, UI flow, and verification pipeline are 90% identical across both systems; only the inner domain payload of `integration-spec.json` differs:

| Component inside `integration-spec.json` | Multi-Rail Payment Gateway (`payment-gateway-monolith`) | Voucher Provider Management System |
| :--- | :--- | :--- |
| **Identity & Metadata** | `gateway` (`code`, `name`, `operator`, `country`, `aliases`, `kind`), `environments` (`SANDBOX`, `LIVE` URLs & allowed hosts) | `provider` (`name`, `base_url`), `provider_meta` (`key`, `type`, `value` rows) |
| **Authentication & Credentials** | `gateway_auth` (10 auth methods) + `required_credentials` manifest (`owner_type`, `settlement_target`, secret keys) | `auth_method` (`NONE`, `PERMANENT_TOKEN`, `REFRESH_TOKEN`, `USERNAME_PASSWORD`, `BASIC_AUTH`), `auth_apply`, + `required_credentials` manifest |
| **Customer / Service Catalog** | `rail` (`code`, `name_ar`, `name_en`, `collection_mode`, `capabilities`), `rail_fields` (form inputs, regex, normalizers), `rail_route` (limits, cost model) | `service_link` (`listing_source`: `FIXED` products or `API` listing config with `list_selector`, `amount_selector`, `price_selector`, `face_value_selectors`) |
| **Execution Engine & Crypto** | `crypto_profiles` (HMAC/RSA recipes), `flows` across the 10 phases (`INITIATE`, `SUBMIT`, `VERIFY`, etc.) with `TransformPipe[]`, `confirmation_channels`, `status_rules`, `error_maps` | `purchase_query_stack` (`order_index`, `method`, `url`, `content_type`, `success_check`, `parameters` with `recursiveSet` keys), `provider_extraction` (`secret_selector`, `serial_number_selector`, `meta`) |
| **Embedded Self-Test Vectors** | Sample `initiate` / `confirm` / `webhook` payloads + expected canonical status, signature string, and wire amount | Sample `api_listing` response + sample `purchase` response + expected extracted voucher secret/serial/price |

## 5. High-Level OpenCode Implementation Plan (Reusable Across Both Systems)

You can hand these 5 milestones to **OpenCode** for first implementing the feature in [`payment-gateway-monolith`](https://github.com/selmotamed-ctrl/payment-gateway-monolith) and then porting the exact same module structure to the Voucher Provider Management System:

### Milestone 1: Unified Spec Zod Schema & Cross-Field Semantic Validator
- **Where:**
  - Payment Gateway: `core-back/engine/specImporter/specSchema.ts` & `specValidator.ts` (mirrored in `admin-back/lib/zReady/specSchema.ts`).
  - Voucher System: `back/lib/specImporter/specSchema.ts` & `specValidator.ts`.
- **What to Build:**
  - Define the complete `IntegrationSpecSchema` in Zod 4 covering identity, auth, required credentials manifest, flows/queries, mappings/extractions, and `test_vectors`.
  - Write `validateSpecSemantics(spec)` that checks cross-field rules (no `PREVIOUS_RESPONSE` on step 0, SSRF URL rules, valid transform pipelines, valid dot-path selectors) and returns structured, AI-friendly error diagnostics (`{ path, code, message, aiFixHint }`).

### Milestone 2: Dynamic AI Transcript Generator (`GET /spec-kit/transcript`)
- **Where:**
  - Payment Gateway: `core-back/engine/specImporter/TranscriptBuilder.ts` -> exposed via `admin-back` at `GET /api/v1/admin/gateways/ai-transcript`.
  - Voucher System: `back/lib/specImporter/TranscriptBuilder.ts` -> exposed at `GET /api/admin/providers/ai-transcript`.
- **What to Build:**
  - A generator that outputs a downloadable `AI-Integration-Transcript.md` file dynamically populated from the live Zod schema enums, transform whitelist, and 2 gold-standard reference examples, plus a structured prompt footer where the user pastes their provider docs.

### Milestone 3: Offline Vector Simulator & Dry-Run Verifier (`POST /spec-kit/verify`)
- **Where:**
  - Payment Gateway: `core-back/engine/specImporter/SpecSimulator.ts` -> exposed via `admin-back` at `POST /api/v1/admin/gateways/spec-verify`.
  - Voucher System: `back/lib/specImporter/SpecSimulator.ts` -> exposed at `POST /api/admin/providers/spec-verify`.
- **What to Build:**
  - Accepts an uploaded `integration-spec.json`.
  - Runs Layer 1 (Zod), Layer 2 (Semantics & SSRF), Layer 3 (executes the spec's parameter builders, transforms, crypto signers, and response extractors against the spec's own `test_vectors` in memory), and Layer 4 (collision detection).
  - Returns a verification report: `{ valid: boolean, summary, requiredCredentials: [...], vectorResults: [...], errors: [...], aiRepairPrompt?: string }`.
  - Note the **`aiRepairPrompt`** field: if verification fails, the backend automatically formats the exact validation/simulation errors into a ready-to-copy message the admin can paste back to the AI so the AI fixes the JSON in one turn.

### Milestone 4: Atomic Spec Materializer (`POST /spec-kit/import`)
- **Where:**
  - Payment Gateway: `core-back/engine/specImporter/SpecMaterializer.ts` -> exposed via `admin-back` at `POST /api/v1/admin/gateways/spec-import`.
  - Voucher System: `back/lib/specImporter/SpecMaterializer.ts` -> exposed at `POST /api/admin/providers/spec-import`.
- **What to Build:**
  - Accepts `{ spec, credentialsValues, mode: 'CREATE_NEW' | 'NEW_VERSION' }`.
  - Re-runs full verification inside `core-back` (Double-Check Rule), encrypts the supplied `credentialsValues` using AES-256-GCM (`Vault`), and inserts the Gateway, `DRAFT` GatewayVersion, Environments, Auth, CredentialSet, CryptoProfiles, Flows, Steps, Channels, StatusRules, ErrorMaps, Rail, RailFields, and paused RailRoute (or Provider, Meta, Query Stack, Extraction, and Service link in the Voucher System) in **one atomic Prisma transaction**.

### Milestone 5: Admin Portal "Smart AI Integration" Modal/Wizard (`admin-front`)
- **Where:**
  - Payment Gateway: `admin-front/src/pages/gateways/ai-import/index.tsx` (built in Vue 3 TSX with `dc()` from `kt-dc`).
  - Voucher System: `front/src/pages/providers/ai-import/index.tsx`.
- **What to Build:**
  - A clean 3-step TSX view:
    1. **Download Kit:** Button to download `AI-Integration-Transcript.md` (with optional checkboxes for what kind of rail/provider they are integrating so the transcript can tailor its examples).
    2. **Upload & Verify Spec:** Drag-and-drop `.json` uploader that displays the 4-layer verification scorecard, simulated request/response previews from `test_vectors`, or a 1-click **"Copy AI Repair Prompt"** button if any check failed.
    3. **Bind Secrets & Create Draft:** Dynamically renders password inputs for every key in `required_credentials`, saves the draft integration, and lets the admin trigger a live test call right from the screen.
